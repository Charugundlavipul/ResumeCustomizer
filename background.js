
try {
  importScripts(chrome.runtime.getURL('libs/jszip.min.js')); // exposes global JSZip
} catch (e) {
  console.warn('JSZip failed to load; zip compilation will be skipped.', e);
}
// remove stray Markdown bold markers *word*  →  word

const escapePercents = s => s.replace(/(^|[^\\])%/g, (_, p1) => `${p1}\\%`);
// replace old escapePercents with this universal escaper

// MV3 background service worker

// ===== Utilities =====
const stripBold = s => s.replace(/\\(.+?)\\/g, "$1");
const escapeLatex = s => {
    if (!s) return "";
    return String(s)
        .replace(/\\/g, '\\textbackslash{}') // Must be first
        .replace(/%/g,  '\\%')
        .replace(/&/g,  '\\&')
        .replace(/#/g,  '\\#')
        .replace(/\$/g, '\\$')
        .replace(/_/g,  '\\_')
        .replace(/{/g,  '\\{')
        .replace(/}/g,  '\\}')
        .replace(/~/g,  '\\textasciitilde{}')
        .replace(/\^/g, '\\textasciicircum{}');
};
function safeJsonFromGemini(raw) {
    if (!raw) return null;
    let txt = raw.trim();
    // More robustly strips markdown code fences
    if (txt.startsWith("```")) {
        txt = txt.replace(/^(?:```(?:json)?\s*)|(?:\s*```)$/g, "").trim();
    }
    // Fallback to find the first and last curly brace
    if (!txt.startsWith("{")) {
        const first = txt.indexOf("{");
        const last = txt.lastIndexOf("}");
        if (first === -1 || last === -1 || last <= first) return null;
        txt = txt.slice(first, last + 1);
    }
    try {
        // Try parsing the cleaned text
        return JSON.parse(txt);
    } catch (e) {
        console.warn("safeJsonFromGemini failed to parse:", e, raw);
        return null;
    }
}

function formatSectionDump(sections, maxChars = 7000) {
    let out = "";
    for (const s of sections) {
        out += `▼ ${s.name} (${s.bullets.length})\n`;
        s.bullets.forEach(b => { out += `  • ${b}\n`; });
        out += "\n";
        if (out.length > maxChars) {
            out += "…\n";
            break;
        }
    }
    return out.trim();
}
// ===== Gemini API Callers =====
async function geminiRefineSkills(apikey, jd, skillsLines, mustInclude = []) {
    const skillsDump = Object.entries(skillsLines).map(([k, v]) => `${k}: ${v}`).join("\n");
    const prompt = `You are an AI assistant that refines resume skill sections to match a job description. Your task is to take the user's current skill lines, a job description, and a mandatory list of skills, then generate a JSON array of 'replace_skill_csv' operations to update the skills.

## JSON OUTPUT SPECIFICATION
- Your entire response MUST be a single raw JSON object. Do not add markdown wrappers.
- The root of the object must be a key "ops" containing an array of objects.
- Each object in the "ops" array must have this exact structure:
  {
    "op": "replace_skill_csv",
    "label": "string",
    "csv": "string"
  }

## PROCESSING LOGIC
1. **Incorporate Mandatory Skills**: For EACH skill in the "Mandatory Skills to Include" list, determine the most appropriate skill line and add the skill to that line's CSV. Do not duplicate it.
2. **Refine Existing Skills**: Analyze the job description and subtly re-order or adjust existing skills to align with the job's priorities.
3. **Maintain Original Labels**: Keep the original 'label' for each skill line.

## INPUTS
### Job Description:
${jd.slice(0, 5000)}
### Mandatory Skills to Include:
${mustInclude.join(", ") || "None"}
### CURRENT SKILL LINES:
${skillsDump}`.trim();

    const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0, topP: 0.9, maxOutputTokens: 4000 }
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apikey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`Gemini Refine Skills API error: ${res.status}`);
    const data = await res.json();
    return safeJsonFromGemini(data?.candidates?.[0]?.content?.parts?.[0]?.text || "")?.ops || [];
}

async function geminiExtractMissing(apikey, jd, userKeywords = []) {
    const prompt = `You are an expert ATS keyword extractor. Your sole purpose is to generate a single, valid JSON object based on the provided Job Description (JD) and a list of user-supplied keywords.

## TASK
Analyze the JD and identify technical skills and other important keywords that are present in the JD but *absent* from the user-supplied keyword list.

## JSON OUTPUT SPECIFICATION
Your entire response MUST be a single raw JSON object.
{
  "skills": ["string"],
  "important": ["string"]
}

### Key Descriptions:
- **skills**: An array of up to 12 strictly technical skills (frameworks, tools, databases) from the JD, not in the user's list.
- **important**: An array of up to 12 high-impact keywords (methodologies, qualifications like "performance optimization", "CI/CD pipelines") from the JD.

## RULES
1. **Strict Exclusion**: Keywords in the output MUST NOT be in the "User-Supplied Keywords" list.
2. **JD Source Only**: Keywords MUST appear verbatim in the "JD Text".
3. **Limit**: Do not exceed 12 items per array.

## INPUTS
### JD Text:
${jd.slice(0, 8000)}
### User-Supplied Keywords:
${(userKeywords || []).join(", ")}`.trim();

    const payload = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 2000 }
    };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apikey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`Gemini Extract Missing API error: ${res.status}`);
    const data = await res.json();
    const obj = safeJsonFromGemini(data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
    return {
        skillsMissing: Array.isArray(obj?.skills) ? obj.skills : [],
        importantMissing: Array.isArray(obj?.important) ? obj.important : []
    };
}

async function geminiPlan(apikey, jd, userPrompt, tex, { importantMissing = [] }) {
    const refinedPolicy = `You are an expert resume editor specializing in ATS optimization. Enhance the user's existing resume bullet points to be more impactful while adhering to all rules.

## STRICT RULES
1. **Word Count Windows**: Each rewritten bullet MUST fall within its specific word count window (e.g., a 15-word bullet with a "15-20" window must be rewritten to 15-20 words).
2. **Weave in Keywords**: In each bullet, include one or two words from the 'Important Words' list. Integrate them naturally.
3. **Preserve Core Meaning**: Keep the original intent. All numbers, metrics, and proper nouns must be preserved.
4. **Maintain Structure**: Do NOT add, delete, or reorder bullets.

## OUTPUT FORMAT
Return a single, raw JSON object using the 'replace_bullets' operation.`;

    const instructionBlock = userPrompt?.trim() ? `## USER PROMPT (Highest Priority)\n${userPrompt.trim()}\n` : "";
    // **CHANGE**: This now parses the complete, dynamically built LaTeX file
    const targetSections = allRewriteableSections(tex);
    if (!targetSections.length) return [];

    const limits = targetSections.flatMap(sec => sec.bullets.map(b => `${b.split(/\s+/).length}-${b.split(/\s+/).length + 5}`)).join(", ");
    const schema = `Return STRICT JSON ONLY:\n{"ops":[{"op":"replace_bullets","section":"Section Name","bullets":["...", "..."]}]}`;

    const payload = {
        contents: [{ role: "user", parts: [{ text: `
${refinedPolicy}
${instructionBlock}
## INPUTS
### Job Description:
${jd.slice(0, 5000)}
### Important Words (to include):
${importantMissing.join(", ") || "None"}
### Current Bullets & Their Word Count Windows:
${formatSectionDump(targetSections)}
*Required word count windows (in order): [${limits}]*
## OUTPUT FORMAT
${schema}` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2, topP: 0.8, maxOutputTokens: 4000 }
    };

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apikey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`Gemini Plan API error: ${res.status}`);
    const data = await res.json();
    const obj = await robustGeminiParse(data?.candidates?.[0]?.content?.parts?.[0]?.text || "");
    
    // **CHANGE**: Reconcile against the combined list of sections
    const sectionMap = Object.fromEntries(targetSections.map(s => [s.name.toLowerCase(), s]));
    return reconcileBulletCounts(obj.ops, sectionMap);
}

async function robustGeminiParse(resp) {
    const raw = resp?.trim?.() || "";
    const parsed = safeJsonFromGemini(raw);
    if (!parsed?.ops) {
        console.error("🔴 GEMINI reply could not be parsed into {ops: []} structure ↓↓↓\n" + raw);
        return { ops: [] };
    }
    return parsed;
}
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

// ===== LaTeX Parsers & Manipulators =====
function findSubsections(tex) { // For Work Experience
    const sections = [];
    const sectionRegex = /\\resumeSubheading\s*\{([^}]*)\}[\s\S]*?\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g;
    let match;
    while ((match = sectionRegex.exec(tex)) !== null) {
        const [, title, bulletsBody] = match;
        const bullets = (bulletsBody.match(/\\item\s+([\s\S]*?)(?=\\item|\\end\{itemize\})/g) || []).map(b => b.replace(/\\item\s+/, '').trim());
        if (title.trim() && bullets.length > 0) {
             sections.push({ name: title.trim(), bullets });
        }
    }
    return sections;
}

function findProjectSections(tex) { // **NEW**: Specifically for Projects
    const sections = [];
    const projectBlockRegex = /\\resumeProjectHeading\s*\{([\s\S]*?)\}\{[\s\S]*?\}\s*\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g;
    let match;
    while ((match = projectBlockRegex.exec(tex)) !== null) {
        const [, header, bulletsBody] = match;
        const nameMatch = header.match(/\\textbf\{([^}]+)\}/);
        const name = nameMatch ? nameMatch[1].trim() : "Unknown Project";
        const bullets = (bulletsBody.match(/\\item\s+([\s\S]*?)(?=\\item|\\end\{itemize\})/g) || []).map(b => b.replace(/\\item\s+/, '').trim());
         if (name && bullets.length > 0) {
            sections.push({ name, bullets });
        }
    }
    return sections;
}

function allRewriteableSections(tex) { // **NEW**: Combines work and projects
    const experience = findSubsections(tex);
    const projects = findProjectSections(tex);
    return [...experience, ...projects];
}

function replaceSectionBullets(tex, sectionName, newBullets) {
    const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedName}[\\s\\S]*?\\\\begin\\{itemize\\})([\\s\\S]*?)(\\\\end\\{itemize\\})`);
    if (!tex.match(regex)) {
        console.warn(`Could not find section "${sectionName}" to replace bullets.`);
        return tex;
    }
    return tex.replace(regex, (full, pre, _body, post) => {
        const rebuilt = "\n  \\item " + newBullets.join("\n  \\item ") + "\n";
        return pre + rebuilt + post;
    });
}

function extractSkillLine(tex, label) {
    const rx = new RegExp(`(\\\\item\\s*\\\\textbf\\{${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\}\\{:\\s)([^}]+)(\\})`, "m");
    const m = tex.match(rx);
    return m ? { items: m[2].trim() } : null;
}

function replaceSkillLine(tex, label, csv) {
    const rx = new RegExp(`(\\\\item\\s*\\\\textbf\\{${label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\}\\{:\\s)([^}]+)(\\})`, "m");
    return tex.replace(rx, (f, a, _b, c) => {
        const items = csv.split(",").map(s => s.trim()).filter(Boolean);
        const deduped = [...new Set(items.map(x => x.toLowerCase()))].map(lc => items.find(x => x.toLowerCase() === lc));
        return a + deduped.join(", ") + c;
    });
}

const cleanName = s => String(s || "").replace(/\s*\(\d+\)\s*$/, "").trim();

function reconcileBulletCounts(rawOps, sectionMap) {
    return (rawOps || []).map(op => {
        if (op.op !== "replace_bullets") return op;
        op.section = cleanName(op.section);
        const sec = sectionMap[op.section.toLowerCase()];
        if (!sec || !Array.isArray(op.bullets)) return op;
        const want = sec.bullets.length;
        const got = op.bullets.length;
        if (got < want) {
            op.bullets = [...op.bullets, ...sec.bullets.slice(got)];
        } else if (got > want) {
            op.bullets = op.bullets.slice(0, want);
        }
        return op;
    });
}
// ===== Apply ops from model =====
function applyOps(tex, ops) {
    let out = tex;
    const sectionsCache = allRewriteableSections(out);
    const secByName = (name) => sectionsCache.find(s => s.name.toLowerCase() === cleanName(name).toLowerCase());

    for (const op of (ops || [])) {
        try {
            if (op.op === "replace_bullets") {
                const sec = secByName(op.section);
                if (!sec) continue;
                out = replaceSectionBullets(out, sec.name, op.bullets.map(b => escapeLatex(stripBold(b))));
            } else if (op.op === "replace_skill_csv") {
                if (!op.label || !op.csv) continue;

                // START: NEW SANITIZATION STEP
                // This removes potentially broken LaTeX commands from the AI's response.
                const sanitizedCsv = op.csv.replace(/\\textbf{/g, '').replace(/}/g, '');
                out = replaceSkillLine(out, op.label, escapeLatex(sanitizedCsv));
                // END: NEW SANITIZATION STEP
            }
        } catch (e) {
            console.warn("Failed to apply op", op, e);
        }
    }
    return out;
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
// ===== PDF Compilation & Final Utilities =====
async function compileToPdf(texSource, clsContent = "") {
    const fd = new FormData();

    // Add the main .tex file
    fd.append("filename[]", "document.tex");
    fd.append("filecontents[]", new Blob([texSource], { type: "text/plain" }));

    // If a .cls file's content is provided, add it to the request
    if (clsContent) {
        // This filename MUST match the one in your \documentclass{...} command
        fd.append("filename[]", "fed-res.cls");
        fd.append("filecontents[]", new Blob([clsContent], { type: "text/plain" }));
    }

    fd.append("engine", "pdflatex");
    fd.append("return", "pdf");

    let res = await fetch("https://texlive.net/cgi-bin/latexcgi", { method: "POST", body: fd });

    if (res.status === 301 || res.status === 302) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("Redirect without Location header");
        res = await fetch(new URL(loc, "https://texlive.net").href);
    }

    const buf = await res.arrayBuffer();
    const header = new TextDecoder("ascii").decode(new Uint8Array(buf, 0, 4));
    if (header !== "%PDF") {
        const log = new TextDecoder().decode(new Uint8Array(buf));
        console.error("FULL LaTeX log ↓↓↓\n" + log);
        throw new Error("LaTeX compile failed – see console for full log");
    }
    return buf;
}

function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = "";
    // Avoids "Maximum call stack size exceeded" for large files
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// ===== Main Message Handler (Completely Replaced) =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg.type !== "PROCESS_JD_PIPELINE") return;

        const { jd, prompt, categoryId, selectedProjectIds } = msg.payload || {};
        const { resumeData: DB } = await chrome.storage.local.get("resumeData");

        if (!DB?.apikey) throw new Error("Missing API key in Options.");
        const category = DB.categories.find(c => c.id === categoryId);
        if (!category) throw new Error("Selected category not found.");

        // --- 1. DYNAMICALLY BUILD THE LATEX SOURCE ---
        let latex = category.latex;
        const selectedProjects = DB.projects.filter(p => selectedProjectIds.includes(p.id));

        const projectLatexStrings = selectedProjects.map(p => {
            const linkCmd = p.link ? ` \\href{${p.link}}{\\underline{Link}}` : "";
            const bullets = p.bullets.map(b => `  \\item ${escapeLatex(b)}`).join("\n");
            return `\\resumeProjectHeading
  {\\textbf{${escapeLatex(p.name)}}${linkCmd}}{${escapeLatex(p.dates)}}
  \\begin{itemize}[leftmargin=10pt,itemsep=2pt,parsep=0pt,topsep=5pt,partopsep=0pt]
${bullets}
  \\end{itemize}
  \\vspace{-10pt}`;
        }).join("\n");
        
        const projectsSectionRegex = /(\\section\{Projects\}[\s\S]*?\\resumeSubHeadingListStart)([\s\S]*?)(\\resumeSubHeadingListEnd)/;
        if (latex.match(projectsSectionRegex)) {
            latex = latex.replace(projectsSectionRegex, `$1\n${projectLatexStrings}\n$3`);
        } else {
            console.warn("Could not find a '\\section{Projects}' block to replace.");
        }

        // --- 2. RUN THE REFINEMENT PIPELINE ---
        const apikey = DB.apikey;
        const keywords = Array.isArray(category.keywords) ? category.keywords : [];
        const { skillsMissing, importantMissing } = await geminiExtractMissing(apikey, jd, keywords);

        // -- Pass 1: Bullet Rewrite --
        const bulletOps = await geminiPlan(apikey, jd, prompt, latex, { importantMissing });
        let finalLatex = applyOps(latex, bulletOps);

        // -- Pass 2: Skill Refinement --
        const skillLabels = ["Programming Languages", "Frameworks and Libraries", "Databases", "Tools and Technologies", "Cloud Platforms and Deployment", "Software Development Practices", "Certifications"];
        const skills = {};
        for (const lab of skillLabels) {
            const line = extractSkillLine(finalLatex, lab);
            if (line) skills[lab] = line.items;
        }
        const skillOps = await geminiRefineSkills(apikey, jd, skills, skillsMissing);
        finalLatex = applyOps(finalLatex, skillOps);

        // --- 3. COMPILE FINAL PDF ---
        const pdfBuf = await compileToPdf(finalLatex, category.clsFileContent);
        const pdfB64 = arrayBufferToBase64(pdfBuf);
        sendResponse({ pdfB64, tex: finalLatex });

    })().catch(err => {
        console.error("PIPELINE FAILED:", err);
        sendResponse({ error: err.message });
    });
    return true; // Required for async sendResponse
});



chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg.type !== "PROCESS_JD_PIPELINE") return;

        const { jd, prompt, categoryId, selectedProjectIds } = msg.payload || {};
        const { resumeData: DB } = await chrome.storage.local.get("resumeData");

        if (!DB?.apikey) throw new Error("Missing API key in Options.");
        const category = DB.categories.find(c => c.id === categoryId);
        console.log("DEBUG: Found category object:", category);
        if (!category || !category.latex) throw new Error("Selected category not found or has no LaTeX template.");
        console.log("DEBUG: Found category object:", category); // <-- ADD THIS LINE

        // --- 1. DYNAMICALLY BUILD THE LATEX SOURCE ---
        let latex = category.latex;
        const selectedProjects = DB.projects.filter(p => selectedProjectIds.includes(p.id));

        const projectLatexStrings = selectedProjects.map(p => {
            const linkCmd = p.link ? ` \\href{${p.link}}{\\underline{Link}}` : "";
            const bullets = p.bullets.map(b => `  \\item ${escapeLatex(b)}`).join("\n");
            return `\\resumeProjectHeading
  {\\textbf{${escapeLatex(p.name)}}${linkCmd}}{${escapeLatex(p.dates)}}
  \\begin{itemize}[leftmargin=10pt,itemsep=2pt,parsep=0pt,topsep=5pt,partopsep=0pt]
${bullets}
  \\end{itemize}
  \\vspace{-10pt}`;
        }).join("\n\\vspace{4pt}\n");

        // Use a placeholder comment to inject projects
        const injectionMarker = "%PROJECTS WILL BE DYNAMICALLY INJECTED HERE";
        if (latex.includes(injectionMarker)) {
            latex = latex.replace(injectionMarker, projectLatexStrings);
        } else {
            console.warn("Could not find project injection marker. Check your LaTeX template for '%PROJECTS WILL BE DYNAMICALLY INJECTED HERE'");
        }

        // --- 2. RUN THE REFINEMENT PIPELINE ---
        const apikey = DB.apikey;
        const keywords = Array.isArray(category.keywords) ? category.keywords : [];
        const { skillsMissing, importantMissing } = await geminiExtractMissing(apikey, jd, keywords);

        // -- Pass 1: Bullet Rewrite --
        const bulletOps = await geminiPlan(apikey, jd, prompt, latex, { importantMissing });
        let finalLatex = applyOps(latex, bulletOps);

        // -- Pass 2: Skill Refinement --
        const skillLabels = ["Programming Languages", "Frameworks and Libraries", "Databases", "Tools and Technologies", "Cloud Platforms and Deployment", "Software Development Practices", "Certifications"];
        const skills = {};
        for (const lab of skillLabels) {
            const line = extractSkillLine(finalLatex, lab);
            if (line) skills[lab] = line.items;
        }
        const skillOps = await geminiRefineSkills(apikey, jd, skills, skillsMissing);
        finalLatex = applyOps(finalLatex, skillOps);

        // --- 3. COMPILE FINAL PDF ---
        const pdfBuf = await compileToPdf(finalLatex, category.clsFileContent);
        console.log("DEBUG: CLS content being sent to compiler:", category.clsFileContent); // <-- ADD THIS LINE
        const pdfB64 = arrayBufferToBase64(pdfBuf);
        sendResponse({ pdfB64, tex: finalLatex });

    })().catch(err => {
        console.error("PIPELINE FAILED:", err);
        sendResponse({ error: err.message });
    });
    return true; // Required for async sendResponse
});
// ── LaTeX guard ──
// turn “… 35% improvement” → “… 35\% improvement”
