// MV3 background service worker (type: module)

// ===== Utilities =====
// MV3 background service worker (classic) — allow importScripts
try {
  importScripts(chrome.runtime.getURL('libs/jszip.min.js')); // exposes global JSZip
} catch (e) {
  console.warn('JSZip failed to load; zip compilation will be skipped.', e);
}
// remove stray Markdown bold markers *word*  →  word
const stripBold = s => s.replace(/\\(.+?)\\/g, "$1");

const escapePercents = s => s.replace(/(^|[^\\])%/g, (_, p1) => `${p1}\\%`);
// replace old escapePercents with this universal escaper
const escapeLatex = s =>
  s
    // %  first (already handled)
    .replace(/(^|[^\\])%/g, (_, p1) => `${p1}\\%`)
    // &  _  #  $   (and optionally ^ ~ \)
    .replace(/([&#_$])/g, "\\$1");      // <- add more inside [] if needed

const STOPWORDS = new Set(
  "and or the a an to of in on for with by from at as is are was were be being been into about over under this that these those it its their our your you we they i will can may might should must vs via per"
    .split(" ")
);
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9+\-#_. ]/g, " ").replace(/\s+/g, " ").trim();

function naiveStem(token) {
  let t = token.toLowerCase();
  for (const suf of ["ing","edly","ed","es","s"]) {
    if (t.endsWith(suf) && t.length > suf.length + 2) {
      t = t.slice(0, -suf.length);
      break;
    }
  }
  return t;
}

async function geminiRefineSkills(apikey, jd, skillsLines, mustInclude = []) {
  
  const skillsDump = Object.entries(skillsLines)
        .map(([k,v]) => `${k}: ${v}`).join("\\n");

  const prompt = `You are an AI assistant that refines resume skill sections to match a job description.
Your task is to take the user's current skill lines, a job description, and a mandatory list of skills, then generate a JSON array of 'replace_skill_csv' operations to update the skills.

## JSON OUTPUT SPECIFICATION
- Your entire response MUST be a single raw JSON object. Do not add markdown like \\\`json or any other text.
- The root of the object must be a key "ops" containing an array of objects.
- Each object in the "ops" array must have this exact structure:
  {
    "op": "replace_skill_csv",
    "label": "string", // The original label, e.g., "Programming Languages"
    "csv": "string"    // The new, refined comma-separated list of skills.
  }

## PROCESSING LOGIC & RULES
Follow these steps in order:

1.  *Core Mandate - Incorporate Mandatory Skills*: This is the highest priority. For EACH skill in the "Mandatory Skills to Include" list:
    a. Determine the most appropriate skill line (label) from the "CURRENT SKILL LINES" to add it to.
    b. Add the skill to that line's CSV in between, not at the end.
    c. Do not duplicate it if it already exists.
    

2.  *Final Formatting*:
    a. Ensure the final output is a valid JSON array as specified.
    b. Keep the original 'label' for each skill line.
    c. Do not invent any skills that are not from the mandatory list, the original skill lines, or the job description.

## INPUTS

### Job Description:
${jd.slice(0, 5000)}

### Mandatory Skills to Include:
${mustInclude.join(", ") || "None"}

### CURRENT SKILL LINES:
${skillsDump}`.trim();


  const payload = {
    contents:[{role:"user",parts:[{text:`
${prompt}

Job description (trimmed):
${jd.slice(0,5000)}

CURRENT SKILL LINES:
${skillsDump}
`}]}],
    generationConfig:{temperature:0,topK:1,topP:0.9,maxOutputTokens:4000}
  };

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key="+
    encodeURIComponent(apikey),
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)}
  );
  const data = await res.json();
  return safeJsonFromGemini(
           data?.candidates?.[0]?.content?.parts?.[0]?.text||"")?.ops || [];
}


function safeJsonFromGemini(raw) {
  if (!raw) return null;
  let txt = raw.trim();

  // Strip  fences and a leading “json”
  if (txt.startsWith(""))
    txt = txt.replace(/^(?:json)?\s*/i, "")
             .replace(/$/i, "")
             .trim();
  txt = txt.replace(/^json\s*/i, "").trim();
  txt = txt.replace(/\\([^"\\\/bfnrtu])/g, "\\\\$1");

  // First attempt – maybe it’s already clean
  try { return JSON.parse(txt); } catch (_) {}

  // Fallback – cut from first { … last }
  const first = txt.indexOf("{");
  const last  = txt.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  try { return JSON.parse(txt.slice(first, last + 1)); } catch (_) {}

  // Give up
  return null;
}


function formatSectionDump(sections, maxChars = 7000) {
  // produce a concise dump that still fits in the context window
  let out = "";
  for (const s of sections) {
    out += `▼ ${s.name} (${s.bullets.length})\n`;
    for (let i = 0; i < s.bullets.length; i++) {
      out += `  • ${s.bullets[i]}\n`;
    }
    out += "\n";
    if (out.length > maxChars) { out += "…\n"; break; }
  }
  return out.trim();
}

async function robustGeminiParse(resp) {
  // resp is whatever data?.candidates?.[0]?.content?.parts?.[0]?.text
  const raw = resp?.trim?.() || "";
  let parsed = safeJsonFromGemini(raw);

  // ── Fallback #1 – look for nested { "ops": … } envelope ──
  if (!parsed?.ops) {
    try {
      const m = raw.match(/\{[\s\S]"ops"\s:\s*\[[\s\S]?\}[\s\S]?\}/);
      if (m) parsed = JSON.parse(m[0]);
    } catch (_) {}
  }

  // ── Fallback #2 – try to reach second candidate ──
  if (!parsed?.ops && resp?.candidates?.[1]) {
    parsed = safeJsonFromGemini(
      data.candidates[1]?.content?.parts?.[0]?.text || ""
    );
  }

  // ── Give up but don’t crash the worker ──
  if (!parsed?.ops) {
    console.error("🔴 GEMINI reply could not be parsed ↓↓↓\n" + raw);
    return { ops: [] };          // empty list instead of exception
  }
  return parsed;
}


// ───── NEW helper ─────
async function geminiExtractMissing(apikey, jd, userKeywords = []) {


  const payload = {
    contents: [{
      role: "user",
      parts: [{
        text: `You are an expert ATS keyword extractor. Your sole purpose is to generate a single, valid JSON object based on the provided Job Description (JD) and a list of user-supplied keywords. Do not include any explanations or conversational text in your response.

## TASK
Analyze the JD and identify technical skills and other important keywords that are present in the JD but *absent* from the user-supplied keyword list.

## JSON OUTPUT SPECIFICATION
Your entire response MUST be a single raw JSON object, without any markdown wrappers like \\\`json.
The JSON object must strictly adhere to the following schema:
{
  "skills": ["string"],
  "important": ["string"]
}

### Key Descriptions:
- *skills*: An array of strings. Populate this with upto 12 Strictly with technical skills, frameworks, tools, cloud platforms, and databases only found in the JD but not in the user's list.
- **important**: An array of strings. Populate this with up to 12 high-impact, ATS-friendly keywords from the JD. These should be specific, integratable terms like skills, methodologies, or qualifications (e.g., "performance optimization", "CI/CD pipelines") and not broad concepts (e.g., "computer science").

## RULES
1.  *Strict Exclusion*: Every keyword in the final JSON output MUST NOT be present in the "User-Supplied Keywords" list.
2.  *JD Source Only*: Every keyword in the final JSON output MUST appear verbatim in the "JD Text".
3.  *Limit*: The "important" array must not contain more than 12 items.
4.  *Empty is OK*: If no matching keywords are found for a category, return an empty array '[]'.
5.  *Trivial Words*: Exclude common stop-words and trivial English words.

## INPUTS

### JD Text:
${jd}

### User-Supplied Keywords:
${(userKeywords||[]).join(", ")}`.trim()
      }]
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 5000 }
  };

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key="+
    encodeURIComponent(apikey),
    { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(payload)}
  );
  if (!res.ok) throw new Error("Gemini extract call failed: "+res.status);
  const data = await res.json();
  // … after you get the raw text             ↓ original line
let txt = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";

// ── NEW: unwrap json …  or  …  if present ──
if (txt.startsWith("")) {
  // remove the opening json or  plus the closing 
  txt = txt.replace(/^(?:json)?\s*|\s*$/g, "").trim();
}

// optional extra: grab the first {...} block if still not pure JSON
if (!txt.startsWith("{")) {
  const m = txt.match(/\{[\s\S]*?\}/);
  if (m) txt = m[0];
}

let obj = {};
try { obj = JSON.parse(txt); }
catch (e) { console.warn("Gemini missing-extract JSON.parse failed", e, txt); }
console.log("Gemini extract missing (skills) →", obj.skills);
console.log("Gemini extract missing (important) →", obj.important);

return {
  skillsMissing: Array.isArray(obj.skills)    ? obj.skills    : [],
  importantMissing: Array.isArray(obj.important) ? obj.important : []
};

  
}


function tokenize(text) { const words = normalize(text).split(" ").filter(Boolean); const keep=[]; for(const w of words){ if(!STOPWORDS.has(w)&&w.length>=3) keep.push(naiveStem(w)); } return [...new Set(keep)]; }
function diffMissing(jdText, resumeKeywordList) { const jdTokens = tokenize(jdText); const resumeTokens = new Set((resumeKeywordList||[]).map(k=>naiveStem(k))); return jdTokens.filter(t=>!resumeTokens.has(t)).slice(0,80); }

// Replace your existing findSubsections with this version
function findSubsections(tex) {
  const sections = [];
  const startRe = /\\resumeSubheading\b/g;       // find each macro start
  const beginRe = /\\begin\{itemize\}/g;
  const endRe   = /\\end\{itemize\}/g;

  let m;
  while ((m = startRe.exec(tex)) !== null) {
    const startIdx = m.index;

    // Find the FIRST \begin{itemize} after this \resumeSubheading
    beginRe.lastIndex = startIdx;
    const b = beginRe.exec(tex);
    if (!b) break; // no itemize ⇒ skip
    const beginIdx = b.index;

    // Find the FIRST \end{itemize} after that begin
    endRe.lastIndex = beginIdx;
    const e = endRe.exec(tex);
    if (!e) break;
    const endIdx = e.index;

    // Extract the section name (1st brace arg) from the header area
    const headerChunk = tex.slice(startIdx, beginIdx);
    const nameMatch = headerChunk.match(/\\resumeSubheading\s*\{\s*([^}])\s}/);
    const name = (nameMatch ? nameMatch[1] : "Unknown").trim();

    // Extract bullets body
    const listBody = tex.slice(beginIdx + "\\begin{itemize}".length, endIdx);

    // Parse bullets robustly (handles Windows/Unix newlines and indentation)
    const bullets = [];
    const bulletRe = /\\item\s+([\s\S]?)(?=(?:\r?\n)\s\\item\s+|$)/g;
    let bm;
    while ((bm = bulletRe.exec(listBody)) !== null) {
      bullets.push(bm[1].trim());
    }

    sections.push({ name, bullets, _beginIdx: beginIdx, _endIdx: endIdx });
    // Continue search after this endIdx
    startRe.lastIndex = endIdx;
  }
  return sections;
}

function replaceSectionBullets(tex, sectionName, newBullets) {
  const rx = new RegExp(
    "(\\\\resumeSubheading\\s*\\{\\s*" + sectionName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") +
    "\\s*\\}[^]?\\\\begin\\{itemize\\})([\\s\\S]?)(\\\\end\\{itemize\\})",
    "m"
  );
  return tex.replace(rx, (full, pre, _body, post) => {
    const rebuilt = "\n  \\item " + newBullets.join("\n  \\item ") + "\n";
    return pre + rebuilt + post;
  });
}

function extractSkillLine(tex,label){ const rx=new RegExp("(\\\\item\\s*\\\\textbf\\{"+label.replace(/[.+?^${}()|[\\]\\\\]/g,'\\$&')+"\\}\\{:\\s)([^}]+)(\\})","m"); const m=tex.match(rx); return m?{items:m[2].trim()}:null; }
function replaceSkillLine(tex,label,csv){ const rx=new RegExp("(\\\\item\\s*\\\\textbf\\{"+label.replace(/[.+?^${}()|[\\]\\\\]/g,'\\$&')+"\\}\\{:\\s)([^}]+)(\\})","m"); return tex.replace(rx,(f,a,_b,c)=>{
  const items = csv.split(",").map(s=>s.trim());
  const dedup = [...new Set(items.map(x=>x.toLowerCase()))]
                  .map(lc => items.find(x=>x.toLowerCase()===lc));
  return a + dedup.join(", ") + c;
}); }
// helper inside geminiPlan (add above the return)
function appendSkillsCsv(tex, label, newItems) {
  const line = extractSkillLine(tex, label);
  if (!line) return tex;

  const have = line.items.split(",").map(s => s.trim());
  const added = newItems.filter(x =>
    !have.some(h => h.toLowerCase() === x.toLowerCase())
  );
  if (!added.length) return tex;

  const csv = [...have, ...added].join(", ");
  return replaceSkillLine(tex, label, escapeLatex(csv));
}

const cleanName = s => String(s||"").replace(/\s*\(\d+\)\s*$/, "").trim();
function reconcileBulletCounts(rawOps, sectionMap) {
  return rawOps.map(op => {
    if (op.op !== "replace_bullets") return op;
    op.section = cleanName(op.section);          // ← normalise once
    const sec  = sectionMap[op.section.toLowerCase()];
    if (!sec || !Array.isArray(op.bullets)) return op;

    const want = sec.bullets.length;
    const got  = op.bullets.length;

    if (got < want) {                    // pad with originals
      op.bullets = [
        ...op.bullets,
        ...sec.bullets.slice(got)
      ];
    } else if (got > want) {             // truncate extras
      op.bullets = op.bullets.slice(0, want);
    }
    return op;
  });
}

        // instead of return obj.ops

// ===== Apply ops from model =====
function applyOps(tex, ops, sectionsCache) {
  let out = tex;
  const secByName = (name) => {
    name = cleanName(name);
  return (sectionsCache || findSubsections(out))
           .find(s => s.name.toLowerCase() === name.toLowerCase());
};
  for (const op of (ops || [])) {
    try {
      if (op.op === "replace_bullets") {
        const sec = secByName(op.section); if (!sec) continue;
        if (!Array.isArray(op.bullets) || op.bullets.length !== sec.bullets.length) continue;
        out = replaceSectionBullets(
          out,
          sec.name,
          op.bullets.map(b => escapeLatex(stripBold(b)))
        );
      } else if (op.op === "add_bullet") {
        const sec = secByName(op.section); if (!sec || !op.bullet) continue;
        const rx = new RegExp("(\\\\resumeSubheading\\s*\\{\\s*" + sec.name.replace(/[.+?^${}()|[\\]\\\\]/g,'\\$&') + "\\s\\}[^]?\\\\begin\\{itemize\\})([\\s\\S]?)(\\\\end\\{itemize\\})","m");
        out = out.replace(
          rx,
          (full, pre, body, post) =>
            `${pre}${body}  \\item ${escapeLatex(stripBold(op.bullet))}\n${post}`
        );
      } else if (op.op === "replace_skill_csv") {
        if (!op.label || typeof op.csv !== "string") continue;
        const existing = extractSkillLine(out, op.label); if (!existing) continue;
        const beforeCount = existing.items.split(",").length, afterCount = op.csv.split(",").length;
        // if (beforeCount !== afterCount) continue;
        out = replaceSkillLine(out, op.label, escapeLatex(op.csv));
      } else if (op.op === "replace_text") {
        if (op.find && typeof op.replace === "string") {
          const rgx = new RegExp(op.find, "m"); out = out.replace(rgx, escapeLatex(op.replace));
        }
      }
    } catch (e) { console.warn("Failed to apply op", op, e); }
  } return out;
}
// NEW – replace firstTwoExperience()
function allExperienceSections(sections) {
  return sections.filter(s =>
    /software|engineer|intern|developer/i.test(s.name)
  );
}
function enforceBulletPolicy(originalSecs, newSecs, important) {
  const must = new Set(important.map(w => w.toLowerCase().trim()).filter(Boolean));

  const ok = (orig, rew) => {
    const oLen = orig.split(/\s+/).filter(Boolean).length;
    const rLen = rew.split(/\s+/).filter(Boolean).length;
    console.log(`Bullet lengths: original=${oLen}, rewritten=${rLen}`);
    if (rLen < oLen - 1 || rLen - oLen > 4) return false;          // NEW window

    let hits = 0;
    for (const w of rew.toLowerCase().split(/\s+/))
      if (must.has(w) && ++hits >= 2) break;
    return hits >= 2;
  };

  for (let s = 0; s < originalSecs.length; s++) {
    const oBullets = originalSecs[s].bullets;
    const nBullets = newSecs[s].bullets;
    for (let i = 0; i < oBullets.length; i++)
      if (!ok(oBullets[i], nBullets[i])) nBullets[i] = oBullets[i]; // revert
  }
}



// ===== Gemini plan (supports Rewrite Prompt) =====
async function geminiPlan(
  apikey,
  jd,
  userPrompt,
  sections,
  skills,
  { skillsMissing = [], importantMissing = [], missingStems = [] },
  allowedAdditions,{ includeSkillsOps = false } = {}  
) {
/* ---------- BULLET-REWRITE PROMPT ---------------------------------- */
// Replace the old defaultPolicy with this
const refinedPolicy = `
You are an expert resume editor specializing in ATS optimization. Your primary objective is to enhance and slightly expand the user's existing resume bullet points to be more impactful, while strictly adhering to all rules below.

## STRICT RULES
1.  *Adhere to Word Count Windows (ABSOLUTE REQUIREMENT)*: This is your most important task. Each rewritten bullet MUST fall within its specific word count window provided below. Do not make bullets shorter than the minimum. After rewriting, double-check that each bullet respects its specific word count.

2.  *Weave in Keywords Naturally: In Each rewritten bullet it is good to include at one or two words from the 'Important words' list. Integrate them seamlessly as you wish. **Do not* just list them at the end if you find any word irrelevant to the bullet then ignore it and dont use the same in other bullets. If none fit, use your judgment to select the most relevant ones. Avoid overstuffing; 1 or 2 keywords per bullet is sufficient.

3.   *Preserve Core Meaning & Data*: Try to keep the original intent of the bullet but you can slightly modify it. All numbers, metrics, dates, and LaTeX commands should be intact if possible, you are allowed to remove 5 to 8 words in the bullet which are again not in the important list, this is to preserve word count rule stated above.

4.  *Maintain Structure: Do **not* add, delete, or reorder the bullets. You must return the same number of bullets for each section.

5.  *Improve Quality*: Avoid repetitive phrasing like 'a key aspect'. Use strong, varied action verbs and especially do not repeat keywords if you feel there are few keywords use them only in relevant sentences dont force them into each sentence.

## OUTPUT FORMAT
Return a single, raw JSON object and nothing else. The JSON must use the 'replace_bullets' operation as specified.
`.trim();

// Keep this part the same
const instructionBlock =
  userPrompt?.trim()
    ? `## USER PROMPT (Highest Priority)\n${userPrompt.trim()}\n`
    : "";

const target = allExperienceSections(sections);
const limits = target.flatMap(sec =>
  sec.bullets.map(b => {
    const n = b.split(/\s+/).filter(Boolean).length;
    return `${n}-${n + 5}`;
  })
).join(", ");

const schema = `

Return STRICT JSON ONLY:

{"ops":[

 {"op":"replace_bullets","section":"Section Name","bullets":["...", "..."]},

 {"op":"add_bullet","section":"Section Name","bullet":"..."}

]}`.trim();

// This part changes. We integrate everything into one final prompt text.
const payload = {
  contents: [{
    role: "user",
    parts: [{
      text: `
${refinedPolicy}

${instructionBlock}

## INPUTS

### Job Description (for context):
${jd.slice(0, 5000)}

### Important Words (to include):
${importantMissing.join(", ") || "None"}

### Current Bullets & Their Word Count Windows:
${formatSectionDump(target).replace(/\n/g, "\\n")}
*Required word count windows (in order): [${limits}]*

## OUTPUT FORMAT
${schema}`
    }]
  }],
  generationConfig: { temperature: 0.1, topK: 1, topP: 0.8, maxOutputTokens: 2000 }
};
/* ------------------------------------------------------------------- */

// ─────────────────────────────────────────────────────────────────

  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key="+encodeURIComponent(apikey),{
    method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload)
  });
  console.log(JSON.stringify(payload));
  if (!res.ok) throw new Error("Gemini API error: " + res.status);
  const data = await res.json();
  
    const obj = await robustGeminiParse(
  data?.candidates?.[0]?.content?.parts?.[0]?.text || ""
);
// robustGeminiParse guarantees obj.ops is at least an empty []


  if (!includeSkillsOps) {
    obj.ops = obj.ops.filter(op => op.op !== "replace_skill_csv");
  }

  // ── bullet-count reconciler lives INSIDE geminiPlan ──
  const sectionMap = Object.fromEntries(
    sections.map(s => [s.name.toLowerCase(), s])
  );
  const ops = reconcileBulletCounts(obj.ops, sectionMap);

  return ops;   // final return
}               // ← end of geminiPlan()




// ===== Compile LaTeX → PDF (multi-file, PDF-only) via texlive.net =====
async function compileToPdf(texSource) {
  // Read config & assets
  const [{ engine = "pdflatex" }, { assets = [] }] = await Promise.all([
    new Promise(res => chrome.storage.sync.get(["engine"], v => res(v || {}))),
    new Promise(res => chrome.storage.local.get(["assets"], v => res(v || {}))),
  ]);

  const fd = new FormData();
  // main file MUST be named document.tex for latexcgi
  fd.append("filename[]", "document.tex");
  fd.append("filecontents[]", new Blob([texSource], { type: "text/plain" }));

  for (const a of (assets || [])) {
    try {
      // Accept both shapes: { dataBase64 } (new) OR { data } (old)
      const b64 = a?.dataBase64 || a?.data;
      if (!b64) {
        console.warn("Skip asset (no base64):", a?.name);
        continue;
      }
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const blob  = new Blob([bytes], { type: a.mime || a.type || "application/octet-stream" });

    // IMPORTANT: TeX is case-sensitive; keep exact filename (e.g., "fed-res.cls")
    fd.append("filename[]", a.name);
    fd.append("filecontents[]", blob);
  } catch (e) {
    console.warn("Skip asset (decode failed):", a?.name, e);
  }
}


  // engine + return type
  fd.append("engine", engine || "pdflatex"); // try "xelatex" if your class needs fontspec
  fd.append("return", "pdf");                // raw PDF bytes, not an HTML viewer

  let res = await fetch("https://texlive.net/cgi-bin/latexcgi", {
    method: "POST",
    body:   fd,
           // we’ll follow ourselves
  });

  // latexcgi returns 301 with Location: /latexcgi/<file>.pdf
  if (res.status === 301 || res.status === 302) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error("Redirect without Location header");
    const pdfURL = new URL(loc, "https://texlive.net").href;
    res = await fetch(pdfURL);                 // second request: the real PDF
  }

  const buf = await res.arrayBuffer();

  if (buf.byteLength < 4) {
    throw new Error(`PDF download came back empty (${buf.byteLength} B).`);
  }
  const header = new TextDecoder("ascii")
                   .decode(new Uint8Array(buf, 0, 4));
  if (header !== "%PDF") {
    const msg = new TextDecoder().decode(new Uint8Array(buf));
  console.error("FULL LaTeX log ↓↓↓\n" + msg);      // <─ NEW
  throw new Error("LaTeX compile failed – see console for full log");
  }
  return buf;
}





chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "PROCESS_JD_PIPELINE") {
      const { jd, prompt } = msg.payload || {};

      // 🔁 use local for big LaTeX; sync for small keys
      const getSync  = (keys) => new Promise(res => chrome.storage.sync.get(keys, v => res(v || {})));
      const getLocal = (keys) => new Promise(res => chrome.storage.local.get(keys, v => res(v || {})));

      // read both stores
      const [{ keywords = [], apikey = "" }, { latex: localLatex = "" }] = await Promise.all([
        getSync(["keywords", "apikey"]),
        getLocal(["latex"])
      ]);

      // one-time migration: if LaTeX was previously stored in sync, move it to local
      let latex = localLatex;
      if (!latex) {
        const { latex: syncLatex = "" } = await getSync(["latex"]);
        if (syncLatex) {
          await chrome.storage.local.set({ latex: syncLatex });
          await chrome.storage.sync.remove("latex");
          latex = syncLatex;
        }
      }

      if (!latex || !apikey) throw new Error("Missing LaTeX or API key in Options.");

      const sections = findSubsections(latex);
      if (!sections.length) throw new Error("Couldn't find any \\resumeSubheading blocks.");

      const labels = [
        "Programming Languages",
        "Frameworks and Libraries",
        "Databases",
        "Tools and Technologies",
        "Software Development Practices",
        "Cloud Platforms and Deployment"
      ];
      const skills = {};
      for (const lab of labels) {
        const line = extractSkillLine(latex, lab);
        if (line) skills[lab] = line.items;
      }

      // ────────────────────────────────────────────────────────────────
// NEW two-pass pipeline ↓↓↓  (bullet rewrite  ➜ skill-line rewrite)
const { skillsMissing, importantMissing } =
      await geminiExtractMissing(apikey, jd, keywords || []);

const missingStems      = diffMissing(jd, keywords || []);
const allowedAdditions  = (keywords || []).map(k => k.trim()).filter(Boolean);

// ─── 1) BULLET REWRITE ──────────────────────────────────────────
const opsBullets = await geminiPlan(
  apikey,
  jd,
  prompt,
  sections,
  skills,
  { skillsMissing, importantMissing, missingStems },
  allowedAdditions,
  { includeSkillsOps: false }          // bullets only
);
latex = applyOps(latex, opsBullets, sections);
const sectionsAfterBullets = findSubsections(latex); // refresh
enforceBulletPolicy(sections, sectionsAfterBullets, importantMissing);

const skillOps = await geminiRefineSkills(apikey, jd, skills, skillsMissing);
latex = applyOps(latex, skillOps, sectionsAfterBullets);
// (add more labels if you like)


// ─── 3) COMPILE FINAL PDF ───────────────────────────────────────
const pdfBuf = await compileToPdf(latex);
const pdfB64 = arrayBufferToBase64(pdfBuf);
sendResponse({ pdfB64, tex: latex });
// ────────────────────────────────────────────────────────────────


    }
  })().catch(err => { console.error(err); try { sendResponse(null); } catch (_) {} });
  return true;
});

// background.js  (replace the 3-line “btoa( String.fromCharCode … )” block)

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 32768;              // 32 kB – well below the arg-limit
  let binary = "";

  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
               null,
               bytes.subarray(i, i + CHUNK)
             );
  }
  return btoa(binary);
}

// ── LaTeX guard ──
// turn “… 35% improvement” → “… 35\% improvement”
