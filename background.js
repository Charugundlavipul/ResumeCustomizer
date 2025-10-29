// MV3 background service worker â€” cleaned, hardened, and drop-in ready

// === Optional dependency (safe to fail) ===
try {
  importScripts(chrome.runtime.getURL("libs/jszip.min.js")); // exposes global JSZip
} catch (e) {
  console.warn("JSZip failed to load; zip compilation will be skipped.", e);
}

function labelToLatexPattern(label) {
  // 1) Escape regex metachars
  let L = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // 2) Handle LaTeX-escaped specials inside \textbf{...}
  // Make "&" match either "&" or "\&" (tolerant), then escape other LaTeX specials.
  L = L
    .replace(/&/g, "(?:\\\\&|&)") // accept both, match your template's \&
    .replace(/%/g, "\\\\%")
    .replace(/\$/g, "\\\\$")
    .replace(/#/g, "\\\\#")
    .replace(/_/g, "\\\\_")
    .replace(/\{/g, "\\\\{")
    .replace(/\}/g, "\\\\}");
  return L;
}


/** â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ CONFIG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * How should the model return bullets?
 * - "TEXT": model returns plain text (no LaTeX). We escape safely on-device.  â† recommended
 * - "LATEX": model returns already LaTeX-safe text (no \item or environments), we trust it.
 */
const GEMINI_BULLET_FORMAT = "TEXT"; // "TEXT" | "LATEX"

/** Strictly keep bullet counts; no visible suffix, no metric appenders */
const ENFORCE_METRIC_VISIBILITY = false; // never append "(retained metrics: ...)" text

const POPUP_STATE_KEY = "popupState";

async function getActiveTab() {
  if (!chrome?.tabs?.query) return null;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs?.[0] || null;
}

async function injectOverlayIntoActiveTab() {
  if (!chrome?.scripting?.executeScript) {
    throw new Error("Missing scripting permission for overlay inject.");
  }

  const tab = await getActiveTab();
  if (!tab?.id || !tab?.url) {
    throw new Error("No active tab available for overlay.");
  }

  if (/^(chrome|edge|about|devtools):/i.test(tab.url)) {
    throw new Error("Cannot show overlay on this page.");
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["overlay.js"],
  });

  return { tabId: tab.id };
}

async function mergePopupState(partial, { token, overwrite = false } = {}) {
  try {
    const stored =
      (await chrome.storage.local.get(POPUP_STATE_KEY))[POPUP_STATE_KEY] || {};

    if (token && stored.generationToken && stored.generationToken !== token) {
      return;
    }

    const next = overwrite
      ? { ...partial }
      : { ...stored, ...partial };

    await chrome.storage.local.set({ [POPUP_STATE_KEY]: next });
  } catch (err) {
    console.warn("Failed to merge popup state", err);
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Only strip stray *markdown* bold, not LaTeX commands.
const stripBold = (s) => String(s || "").replace(/\*(\S(?:.*?\S)?)\*/g, "$1");

// â”€â”€ NEW: robust bullet extractor used everywhere (prevents last-item drop)
// Matches \item bodies until the next \item on a new line OR end-of-body.
function extractBulletsFromItemizeBody(body) {
  const src = String(body || "").replace(/\r\n/g, "\n");
  const re = /(^|\n)\s*\\item\s+([\s\S]*?)(?=\n\s*\\item\b|\s*$)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[2].trim());
  return out;
}

function getOriginalBulletsFromSection(tex, sectionName) {
  const sv = getSectionBodyAndCount(tex, sectionName);
  if (!sv) return [];
  return extractBulletsFromItemizeBody(sv.body);
}

// LaTeX escaping that avoids double-escaping existing sequences.
function escapeLatexSafe(s) {
  if (!s) return "";
  let t = String(s);

  const TOKENS = {
    "\\%": "\uE000",
    "\\_": "\uE001",
    "\\{": "\uE002",
    "\\}": "\uE003",
    "\\#": "\uE004",
    "\\$": "\uE005",
    "\\&": "\uE006",
    "\\~": "\uE007",
    "\\^": "\uE008",
    "\\\\": "\uE009",
  };
  const tokenRe = new RegExp(
    Object.keys(TOKENS).map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|"),
    "g"
  );
  t = t.replace(tokenRe, m => TOKENS[m]);

  t = t
    .replace(/(?<!\\)%/g, "\\%")
    .replace(/(?<!\\)&/g, "\\&")
    .replace(/(?<!\\)#/g, "\\#")
    .replace(/(?<!\\)\$/g, "\\$")
    .replace(/(?<!\\)_/g, "\\_")
    .replace(/(?<!\\)\{/g, "\\{")
    .replace(/(?<!\\)\}/g, "\\}")
    .replace(/(?<!\\)~/g, "\\textasciitilde{}")
    .replace(/(?<!\\)\^/g, "\\textasciicircum{}");

  for (const [k, v] of Object.entries(TOKENS)) {
    const vr = new RegExp(v, "g");
    t = t.replace(vr, k);
  }
  return t;
}

const escapeLatex = escapeLatexSafe;

const cleanBullet = (s) =>
  escapeLatex(stripBold(String(s || "")))
    .replace(/\s*\(\d+\s+(?:words?|chars?|characters?)\)\s*$/i, "")
    .replace(/\s*\(retained metrics:[^)]+\)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

// Remove simple LaTeX commands like \textbf{...} -> keep inner text
const stripLatex = (s) => {
  if (!s) return "";
  return String(s).replace(/\\textbf\{([^}]+)\}/g, "$1");
};

// Safer JSON un-fencer for Gemini responses
function extractBalancedJsonSegment(src) {
  if (!src) return null;
  const txt = String(src);
  const start = txt.search(/[{\[]/);
  if (start === -1) return null;

  const openers = {
    "{": "}",
    "[": "]",
  };
  const closers = new Set(Object.values(openers));

  const stack = [];
  let inString = false;
  let escaping = false;

  for (let i = start; i < txt.length; i++) {
    const ch = txt[i];

    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (openers[ch]) {
      stack.push(openers[ch]);
      continue;
    }

    if (closers.has(ch)) {
      if (!stack.length || stack[stack.length - 1] !== ch) {
        // Mismatched closer; bail out
        return null;
      }
      stack.pop();
      if (!stack.length) {
        return txt.slice(start, i + 1);
      }
    }
  }
  return null;
}

function safeJsonFromGemini(raw) {
  if (!raw) return null;
  let txt = String(raw).trim();

  // Strip fenced code if present
  if (txt.startsWith("```")) {
    txt = txt.replace(/^(?:```(?:json)?\s*)|(?:\s*```)$/g, "").trim();
  }

  // Normalize BOM
  txt = txt.replace(/^\uFEFF/, "");

  const attemptParse = (s) => {
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  };

  // Fast path: the whole thing is already clean JSON
  const direct = attemptParse(txt);
  if (direct) return direct;

  // If the model wrapped text around JSON, grab the first fully balanced JSON segment
  const balanced = extractBalancedJsonSegment(txt);
  if (balanced) {
    const p = attemptParse(
      // make JSON-valid escapes: turn LaTeX-like \% into \\%
      balanced.replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
    );
    if (p) return p;
  }

  // If not found, try to heuristically slice from the first { or [
  if (!/^[{\[]/.test(txt)) {
    const first = txt.search(/[{\[]/);
    const lastObj = txt.lastIndexOf("}");
    const lastArr = txt.lastIndexOf("]");
    const last = Math.max(lastObj, lastArr);
    if (first !== -1 && last !== -1 && last > first) {
      const mid = txt.slice(first, last + 1).replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
      const p = attemptParse(mid);
      if (p) return p;
    }
  }

  // Give up
  console.warn("safeJsonFromGemini: unable to parse:", raw);
  return null;
}


// Targeted extractor for a valid {"ops":[...]} object inside noisy text.
function extractOpsObject(raw) {
  if (!raw) return null;
  const txt = String(raw);
  const start = txt.indexOf('{"ops"');
  if (start === -1) return null;

  let inString = false;
  let escaping = false;
  let depth = 0;

  for (let i = start; i < txt.length; i++) {
    const ch = txt[i];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const segment = txt.slice(start, i + 1);
        try {
          const sanitized = segment.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
          return JSON.parse(sanitized);
        } catch (_) {
          return null;
        }
      } else if (depth < 0) {
        break;
      }
    }
  }
  return null;
}

// Targeted extractor for the ops array if the wrapper is corrupted.
function extractOpsArray(raw) {
  if (!raw) return null;
  const txt = String(raw);
  const m = txt.match(/\"ops\"\s*:\s*/);
  if (!m) return null;
  const afterKey = txt.indexOf(m[0]) + m[0].length;
  const start = txt.indexOf("[", afterKey);
  if (start === -1) return null;

  const openers = { '{': '}', '[': ']' };
  const closers = new Set(Object.values(openers));
  const stack = [']'];
  let inString = false;
  let escaping = false;

  for (let i = start + 1; i < txt.length; i++) {
    const ch = txt[i];
    if (escaping) { escaping = false; continue; }
    if (ch === '\\') { escaping = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (openers[ch]) { stack.push(openers[ch]); continue; }
    if (closers.has(ch)) {
      const need = stack[stack.length - 1];
      if (ch !== need) return null; // mismatched
      stack.pop();
      if (!stack.length) {
        const segment = txt.slice(start, i + 1);
        try {
          const sanitized = segment.replace(/\\(?![\"\\\/bfnrtu])/g, "\\\\");
          const arr = JSON.parse(sanitized);
          return Array.isArray(arr) ? arr : null;
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

// Bruteforce fallback: trim trailing garbage until {"ops": ...} parses.
function bruteForceOpsObject(raw) {
  if (!raw) return null;
  const txt = String(raw);
  const start = txt.indexOf('{"ops"');
  if (start === -1) return null;

  for (let end = txt.length; end > start; end--) {
    const fragment = txt.slice(start, end);
    try {
      const sanitized = fragment.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
      const parsed = JSON.parse(sanitized);
      if (parsed?.ops && Array.isArray(parsed.ops)) return parsed;
    } catch (_) {
      // keep trimming
    }
  }
  return null;
}

async function robustGeminiParse(resp) {
  const raw = resp?.trim?.() || "";

  // 1) Try direct parse first (fast path)
  try {
    const direct = JSON.parse(raw);
    if (direct?.ops && Array.isArray(direct.ops)) return direct;
  } catch (_) {}

  // 2) Our sanitizer
  const parsed = safeJsonFromGemini(raw);
  if (parsed?.ops && Array.isArray(parsed.ops)) return parsed;
  if (Array.isArray(parsed)) return { ops: parsed };

  // 3) Targeted extractors (keep your helpers)
  const opsObj = extractOpsObject(raw);
  if (opsObj?.ops && Array.isArray(opsObj.ops)) return opsObj;

  const opsArr = extractOpsArray(raw);
  if (Array.isArray(opsArr)) return { ops: opsArr };

  const brutal = bruteForceOpsObject(raw);
  if (brutal?.ops && Array.isArray(brutal.ops)) return brutal;

  // 4) Last resort: try to find any array of { op: ... } in a parsed object
  if (parsed && typeof parsed === "object") {
    const candidate = Object.values(parsed).find(
      v => Array.isArray(v) && v.every(it => it && typeof it === "object" && typeof it.op === "string")
    );
    if (candidate) return { ops: candidate };
  }

  console.error(" GEMINI reply could not be parsed into a valid {ops: []} structure ↓↓↓\n" + raw);
  return { ops: [] };
}


function formatSectionDump(sections, maxChars = 7000) {
  let out = "";
  for (const s of sections) {
    out += `${s.name} (${s.bullets.length})\n`;
    s.bullets.forEach((b) => {
      out += `  • ${b}\n`;
    });
    out += "\n";
    if (out.length > maxChars) {
      out += "…\n";
      break;
    }
  }
  return out.trim();
}


async function geminiRefineSkills(apikey, jd, skillsLines, mustInclude = []) {
  const skillsDump = Object.entries(skillsLines)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const prompt = `
You are an AI assistant that refines resume skill sections to match a job description. Your task is to take the user's current skill lines, a job description, and a mandatory list of skills, then generate a JSON array of 'replace_skill_csv' operations to update the skills.

## JSON OUTPUT SPECIFICATION
- Your entire response MUST be a single raw JSON object. Do not add markdown wrappers.
- The root of the object must be a key "ops" containing an array of objects.
- Each object must have this structure: { "op": "replace_skill_csv", "label": "string", "csv": "string" }

## PROCESSING LOGIC
1. **Incorporate Mandatory Skills**: For EACH skill in the "Mandatory Skills to Include" list, determine the most appropriate skill line and add the skill to that line's CSV somewhere in the middle. Do not duplicate it and add only 80% of words from required skill line if there are more than 5 in total.
2. **Refine Existing Skills**: Analyze the job description and subtly re-order or adjust existing skills to align with the job's priorities.
3. **Maintain Original Labels**: Keep the original 'label' for each skill line.
4. Do **not** delete existing entries; even if something is only loosely related, leave it in place and focus on reordering or appending relevant additions instead of pruning.
5. If you extract very few new skills from the job description, supplement by adding additional relevant skills while keeping every original entry intact—augment only, never remove.

## INPUTS
### Job Description:
${jd.slice(0, 5000)}
### Mandatory Skills to Include:
${mustInclude.join(", ") || "None"}
### CURRENT SKILL LINES:
${skillsDump}`.trim();

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
      topP: 0.7,
      thinkingConfig: {
        thinkingBudget: 1400,
      },
      maxOutputTokens: 4000,
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(
      apikey
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) throw new Error(`Gemini Refine Skills API error: ${res.status}`);
  const data = await res.json();
  return (
    safeJsonFromGemini(
      data?.candidates?.[0]?.content?.parts?.[0]?.text || ""
    )?.ops || []
  );
}

async function geminiExtractMissing(apikey, jd, userKeywords = []) {
  const prompt = `
You are an expert ATS keyword extractor. Your sole purpose is to generate a single, valid JSON object based on the provided Job Description (JD) and a list of user-supplied keywords.

## TASK
Analyze the JD and identify technical skills and other important keywords that are present in the JD but *absent* from the user-supplied keyword list.

## JSON OUTPUT SPECIFICATION
Your entire response MUST be a single raw JSON object.
{ "skills": ["string"], "important": ["string"] }

### Key Descriptions:
- **skills**: An array of up to 12 strictly technical skills (frameworks, tools, databases) from the JD, not in the user's list.
- **important**: An array of up to 12 high-impact keywords (methodologies, qualifications like "performance optimization", "CI/CD pipelines") from the JD do not extract keyword which are non technical or pay/wage related.

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
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0,
      
      maxOutputTokens: 3000,
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(
      apikey
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) throw new Error(`Gemini Extract Missing API error: ${res.status}`);
  const data = await res.json();
  const obj =
    safeJsonFromGemini(
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}"
    ) || {};
  return {
    skillsMissing: Array.isArray(obj?.skills) ? obj.skills : [],
    importantMissing: Array.isArray(obj?.important) ? obj.important : [],
  };
}

/** â”€â”€ NEW: collect verified skills from the resume to keep substitutions truthful */
function collectResumeSkillKeywords(tex) {
  const labels = [
    "Programming Languages",
    "Frameworks & Libraries",
    "Databases",
    "Tools and Technologies",
    "Cloud & DevOps",
    "Development Practices",
    "Certifications",
  ];
  const seen = new Set();
  const ordered = [];
  for (const lab of labels) {
    const line = extractSkillLine(tex, lab);
    if (!line) continue;
    const items = stripLatex(line.items)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    for (const item of items) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(item);
    }
  }
  return ordered;
}

async function geminiPlan(
  apikey,
  company,
  jd,
  userPrompt,
  tex,
  {
    targetKeywords = [],
    inResumeKeywords = [],
  } = {}
) {
  const MIN_CHARS = 215;
  const MAX_CHARS = 228;

  const formatHint =
    GEMINI_BULLET_FORMAT === "LATEX"
      ? `Return bullets that are LaTeX-safe text, but DO NOT include LaTeX list commands (no "\\item", no "itemize" blocks).`
      : `Return bullets as plain natural-language text with NO LaTeX markup.`;

  const tgt = (targetKeywords || []).filter(Boolean).slice(0, 80).join(", ");
  const verified = (inResumeKeywords || []).filter(Boolean).slice(0, 160).join(", ");


const refinedPolicy = `
You are an experimental AI resume editor. Rewrite every bullet so it reads as though the candidate already operates inside the Job Description (JD) environment, even when that requires introducing JD technologies or terminology that never appeared in the original resume.

## Core Rules: Non-Negotiable
1.  **JD Stack Supremacy:** Prioritize JD technologies, methodologies, and platform language above the legacy resume stack. Replace legacy tech references with JD-aligned tools unless doing so breaks the quantitative result.
2.  **Introduce Missing Tools:** When the JD highlights tools the resume never mentioned, incorporate them directly as part of the candidate's responsibilities (e.g., rewrite "Node.js microservices" to "Python/FastAPI services" if the JD favors Python). Treat JD tools as canonical.
3.  **Metrics & Outcomes Stay Real:** Keep every original metric, scale figure, and business impact unchanged. You may alter the narrative surrounding how the result was achieved, but never modify the numbers.
4.  **Structure Lock:** STRICTLY maintain the original number of bullets per section and preserve their order.
5.  **Length Gate:** Every bullet MUST be between ${MIN_CHARS} and ${MAX_CHARS} characters.
6.  **No Company Name:** STRICTLY omit the word "${company}" and any internal-only tool names.
7.  **Technology Repetition Cap:** Limit any specific technology (e.g., "React," "Java," "AWS") to a maximum of four mentions across the entire rewritten set.

## JD Alignment Playbook
1.  **Lead with JD Priorities:** Anchor each bullet in the JD's verbs, responsibilities, and stack emphases (backend services, observability, ML Ops, governance, etc.).
2.  **Overhaul Legacy Tech:** Default to swapping legacy technologies with JD technologies. If a legacy stack must remain for context, frame it as the prior state or supporting layer underneath the JD stack.
3.  **Expand Domain Signals:** Add JD domain vocabulary (e.g., "regulatory reporting," "quantitative risk models," "low-latency pipelines") even when the source bullet used broader phrasing.
4.  **Tie Metrics to JD Outcomes:** Explain every preserved metric in terms of the outcomes the JD values (latency, reliability, experimentation speed, cost efficiency, compliance).
5.  **Use Decisive Verbs:** Begin each bullet with verbs that match the JD tone ("Architected," "Orchestrated," "Operationalized," "Hardened," etc.).
6.  **No Safe Fallbacks:** If a JD expectation cannot be matched directly, describe how the candidate enabled or partnered with teams using that JD stack instead of reverting to the legacy narrative.

## Quality & Style
* Exactly one sentence per bullet; remove filler words.
* Never end a bullet with vague phrases like "enhancing user experience," "improving performance," "effectively," "significantly," or "aligning with."
* Default to rewriting; retaining the original wording is a last resort.

## Output Requirements
* Return bullets in their original section order and count.
* Each bullet must follow all rules above.
* each bullet must strictly adhere to the length window of ${MIN_CHARS}-${MAX_CHARS} characters.
`;
  const instructionBlock = userPrompt?.trim()
    ? `## USER PROMPT (Respect the spirit if provided)\n${userPrompt.trim()}\n`
    : "";

  const targetSections = allRewriteableSections(tex);
  if (!targetSections.length) return [];

  const sectionsDump = formatSectionDump(targetSections);

  const windowReminder = targetSections
    .map(sec => sec.bullets.map(() => `${MIN_CHARS}-${MAX_CHARS}`).join(", "))
    .join("; ");

  const schema =
    'RETURN ONLY THIS EXACT JSON (no extra text, no code fences, no trailing characters):\n{"ops":[{"op":"replace_bullets","section":"Section Name","bullets":["...", "..."]}]}';

const responseSchema = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["replace_bullets", "replace"] },
          section: { type: "string" },
          bullets: {
            type: "array",
            items: { type: "string" }
          }
        },
        required: ["op", "section", "bullets"]
      }
    }
  },
  required: ["ops"]
};


 const payload = {
  contents: [
    {
      role: "user",
      parts: [
        {
          text: `
${refinedPolicy}
${instructionBlock}
## INPUTS
### Job Description:
${String(jd)}

### TARGET ROLE STACK (from JD/Category) - prioritize these:
${tgt || "None"}

### Resume Stack Hints (legacy context only; JD may supersede these):
${verified || "None"}

### Current Bullets (keep same COUNT & ORDER; rewrite EACH to strictly ${MIN_CHARS}-${MAX_CHARS} characters; PRESERVE existing metrics):
${sectionsDump}

### Required character-count window for each bullet (by position):
[${windowReminder}]

Return JSON only.`.trim(),
        },
      ],
    },
  ],
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema,                // ⬅️ moved here
    temperature: 0.15,
    topP: 0.8,
    thinkingConfig: { thinkingBudget: 5000 },
    maxOutputTokens: 8000,
  },
};


  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
      apikey
    )}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) throw new Error(`Gemini Plan API error: ${res.status}`);
  const data = await res.json();
  const obj = await robustGeminiParse(
    data?.candidates?.[0]?.content?.parts?.[0]?.text || ""
  );

  return obj.ops || [];
}


// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ LaTeX helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function findSubsections(tex) {
  const sections = [];
  const sectionRegex =
    /\\resumeSubheading\s*\{([^}]*)\}[\s\S]*?\\begin\{itemize\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{itemize\}/g;
  let match;
  while ((match = sectionRegex.exec(tex)) !== null) {
    const [, title, bulletsBody] = match;
    const bullets = extractBulletsFromItemizeBody(bulletsBody);
    if (title.trim() && bullets.length > 0) {
      sections.push({ name: title.trim(), bullets });
    }
  }
  return sections;
}

function findProjectSections(tex) {
  const sections = [];
  const projectBlockRegex =
    /\\resumeProjectHeading\s*\{([\s\S]*?)\}\{[\s\S]*?\}\s*\\begin\{itemize\}(?:\[[^\]]*\])?([\s\S]*?)\\end\{itemize\}/g;
  let match;
  while ((match = projectBlockRegex.exec(tex)) !== null) {
    const [, header, bulletsBody] = match;
    const nameMatch = header.match(/\\textbf\{([^}]+)\}/);
    const name = nameMatch ? nameMatch[1].trim() : "Unknown Project";
    const bullets = extractBulletsFromItemizeBody(bulletsBody);
    if (name && bullets.length > 0) {
      sections.push({ name, bullets });
    }
  }
  return sections;
}

function allRewriteableSections(tex) {
  return [...findSubsections(tex), ...findProjectSections(tex)];
}

const normalizeTitle = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function countItemsInMatchedBody(texSectionBody) {
  return extractBulletsFromItemizeBody(texSectionBody).length;
}

function getSectionBodyAndCount(tex, sectionName) {
  const escapedName = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rxSub = new RegExp(
    `(\\\\resumeSubheading\\s*\\{[\\s\\S]*?${escapedName}[\\s\\S]*?\\}[\\s\\S]*?` +
      `\\\\begin\\{itemize\\}(?:\\[[^\\]]*\\])?)` +
      `([\\s\\S]*?)` +
      `(\\\\end\\{itemize\\})`,
    "i"
  );
  const rxProj = new RegExp(
    `(\\\\resumeProjectHeading[\\s\\S]*?\\{[\\s\\S]*?${escapedName}[\\s\\S]*?\\}[\\s\\S]*?` +
      `\\\\begin\\{itemize\\}(?:\\[[^\\]]*\\])?)` +
      `([\\s\\S]*?)` +
      `(\\\\end\\{itemize\\})`,
    "i"
  );

  const m = tex.match(rxSub) || tex.match(rxProj);
  if (!m) return null;
  const [, pre, body, post] = m;
  return { pre, body, post, wantCount: countItemsInMatchedBody(body) };
}

function buildItemizeBody(bullets) {
  return `\n    \\item ${bullets.join("\n    \\item ")}\n`;
}

function safeReplaceSectionBullets(tex, sectionName, newBullets) {
  const sv = getSectionBodyAndCount(tex, sectionName);
  if (!sv) return tex;

  let rebuilt = buildItemizeBody(newBullets);
  let out = tex.replace(sv.pre + sv.body + sv.post, sv.pre + rebuilt + sv.post);

  const after = getSectionBodyAndCount(out, sectionName);
  if (after) {
    const have = countItemsInMatchedBody(after.body);
    const want = newBullets.length;
    if (have !== want) {
      rebuilt = buildItemizeBody(newBullets);
      out = tex.replace(sv.pre + sv.body + sv.post, sv.pre + rebuilt + sv.post);
    }
  }
  return out;
}

function replaceSectionBullets(tex, sectionName, newBullets) {
  return safeReplaceSectionBullets(tex, sectionName, newBullets);
}

function extractSkillLine(tex, label) {
  const L = labelToLatexPattern(label);

  const rxA = new RegExp(
    `(\\\\item\\s*\\\\textbf\\{${L}\\}\\{:\\s*)([^}]+)(\\})`,
    "m"
  );
  const mA = tex.match(rxA);
  if (mA) return { style: "A", items: mA[2].trim(), a: mA[1], c: mA[3] };

  const rxB = new RegExp(
    `(\\\\item\\s*\\\\textbf\\{${L}\\}:\\s*)([^\\n\\\\]+)`,
    "m"
  );
  const mB = tex.match(rxB);
  if (mB) return { style: "B", items: mB[2].trim(), a: mB[1] };

  return null;
}

function replaceSkillLine(tex, label, csv) {
  const L = labelToLatexPattern(label);
  const items = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const deduped = [...new Set(items.map((x) => x.toLowerCase()))].map((lc) =>
    items.find((x) => x.toLowerCase() === lc)
  );
  const joined = deduped.join(", ");

  const rxA = new RegExp(
    `(\\\\item\\s*\\\\textbf\\{${L}\\}\\{:\\s*)([^}]+)(\\})`,
    "m"
  );
  if (rxA.test(tex)) {
    console.log(`[skills] replaced (brace style): ${label}`);
    return tex.replace(rxA, (_f, a, _b, c) => `${a}${escapeLatex(joined)}${c}`);
  }

  const rxB = new RegExp(
    `(\\\\item\\s*\\\\textbf\\{${L}\\}:\\s*)([^\\n\\\\]+)`,
    "m"
  );
  if (rxB.test(tex)) {
    console.log(`[skills] replaced (colon style): ${label}`);
    return tex.replace(rxB, (_f, a, _b) => `${a}${escapeLatex(joined)}`);
  }

  return tex.replace(
    /\\resumeSubHeadingListStart([\s\S]*?)(?=\\resumeSubHeadingListEnd)/,
    (full, body) =>
      full.replace(
        body,
        `\n\\item \\textbf{${label}}: ${escapeLatex(joined)}\\vspace{-5pt}\n` + body
      )
  );
}

const cleanName = (s) => String(s || "").replace(/\s*\(\d+\)\s*$/, "").trim();

function fixCommonLatexBugs(tex) {
  let t = tex;

  t = t.replace(/\\\\textbf\{/g, "\\textbf{");

  t = t.replace(
    /(\\item\s*)\\textbf\{([^}]+)\}\s*\{\s*:\s*([^\n]*?)\s*\}(\s*\\vspace\{[^}]+\})?/g,
    (_m, item, label, body, vspace = "") =>
      `${item}\\textbf{${label}}: ${body}${vspace ? " " + vspace : ""}`
  );

  t = t.replace(/\\vspace\{([\d.]+)\s+pt\}/g, (_m, num) => `\\vspace{${num}pt}`);

  t = t.replace(/}\s*(?=\\vspace|$)/g, "}");

  return t;
}

function splitIntoCandidateBullets(s) {
  const text = String(s || "");
  if (!text) return [""];
  const parts = text
    .split(/\n(?=(?:[-â€“â€”â€¢]|\d+\.)\s+)|(?<=;)\s+(?=[A-Z(])|(?:\s*\\item\s+)/g)
    .map(x => x.trim());
  return parts.length > 1 ? parts : [text.trim()];
}

function extractMetrics(s) {
  const m = String(s || "").match(/\b(?:\d{1,3}(?:,\d{3})*|\d+)(?:\s*(?:%|x|X|months?|years?|yrs?|sprints?|releases?|users?|requests?|ms|s|sec|mins?|hours?|days?|K|M|B|\$|USD))?\b/g);
  return m ? Array.from(new Set(m.map(x => x.trim()))) : [];
}

function ensureMetricsPreserved(originalBullet, newBullet) {
  if (!ENFORCE_METRIC_VISIBILITY) return newBullet;
  const orig = extractMetrics(originalBullet);
  if (!orig.length) return newBullet;
  const hasAll = orig.every(tok => new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(newBullet));
  if (hasAll) return newBullet;
  return newBullet;
}

function normalizeAIBulletsForSection(originalBulletsLive, aiBulletsRaw, format = GEMINI_BULLET_FORMAT) {
  const want = originalBulletsLive.length;
  let flat = (aiBulletsRaw || []).map(s => String(s ?? "").trim());

  if (flat.length < want) flat = [...flat, ...Array.from({ length: want - flat.length }, (_ , i) => originalBulletsLive[flat.length + i] || "")];
  if (flat.length > want) flat = flat.slice(0, want);

  flat = flat.map((s, i) => (s ? s : (originalBulletsLive[i] || "")));
  flat = flat.map((nb, idx) => ensureMetricsPreserved(originalBulletsLive[idx] || "", nb));

  const finalize = (s) =>
    (format === "LATEX"
      ? String(s || "").replace(/\s*\(\d+\s+(?:words?|chars?|characters?)\)\s*$/i, "").replace(/\s*\(retained metrics:[^)]+\)\s*$/i, "").replace(/\s{2,}/g, " ").trim()
      : cleanBullet(s));

  return flat.map(finalize);
}

function splitMergedBulletText(s) {
  const t = String(s || "").trim();
  if (!t) return [""];
  const parts = t
    .split(/\s*(?:\\item\s+)|\n(?=(?:[-â€“â€”â€¢]|\d+\.)\s+)/g)
    .map(x => x.trim());
  return parts.length ? parts : [t];
}

function applyOps(tex, ops) {
  let out = tex;
  const sectionsCache = allRewriteableSections(out);

  const sectionMap = Object.fromEntries(
    sectionsCache.map((s) => [s.name.toLowerCase(), s])
  );
  const sectionNormMap = Object.fromEntries(
    sectionsCache.map((s) => [normalizeTitle(s.name), s])
  );

  for (const op of ops || []) {
    try {
      if (op.op === "replace_bullets" || op.op === "replace") {
        const sectionName = cleanName(op.section || "");
        let sec = sectionMap[sectionName.toLowerCase()];
        if (!sec) sec = sectionNormMap[normalizeTitle(sectionName)];
        if (!sec || !Array.isArray(op.bullets)) {
          console.warn("Skipping op: section not found or bullets missing.", op);
          continue;
        }

        const liveView = getSectionBodyAndCount(out, sec.name);
        const wantCount = liveView?.wantCount ?? sec.bullets.length;

        const liveOriginals = getOriginalBulletsFromSection(out, sec.name);
        const originals = liveOriginals.length ? liveOriginals : (sec.bullets || []);
        const want = originals.length || wantCount;

        const normalized = normalizeAIBulletsForSection(originals, op.bullets, GEMINI_BULLET_FORMAT);

        let finalBullets =
          normalized.length === want
            ? normalized
            : (normalized.length > want
                ? normalized.slice(0, want)
                : [...normalized, ...originals.slice(normalized.length, want)]);

        if (finalBullets.length !== want) {
          console.warn(`[guard] Bullet count mismatch resolved for section "${sec.name}". want=${want}, got=${finalBullets.length}`);
          finalBullets = finalBullets.slice(0, want);
          if (finalBullets.length < want) {
            finalBullets = [...finalBullets, ...originals.slice(finalBullets.length, want)];
          }
        }

        out = replaceSectionBullets(out, sec.name, finalBullets);
      } else if (op.op === "replace_skill_csv") {
        if (!op.label || !op.csv) continue;
        const sanitizedCsv = op.csv.replace(/\\textbf\{/g, "").replace(/}/g, "");
        out = replaceSkillLine(out, op.label, escapeLatex(sanitizedCsv));
      }
    } catch (e) {
      console.warn("Failed to apply op", op, e);
    }
  }
  return out;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ PDF Compilation Utils â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function compileToPdf(texSource, clsContent = "") {
  const fd = new FormData();

  fd.append("filename[]", "document.tex");
  fd.append("filecontents[]", new Blob([texSource], { type: "text/plain" }));

  if (clsContent) {
    fd.append("filename[]", "fed-res.cls");
    fd.append("filecontents[]", new Blob([clsContent], { type: "text/plain" }));
  }

  fd.append("engine", "pdflatex");
  fd.append("return", "pdf");

  let res = await fetch("https://texlive.net/cgi-bin/latexcgi", {
    method: "POST",
    body: fd,
  });

  if (res.status === 301 || res.status === 302) {
    const loc = res.headers.get("location");
    if (!loc) throw new Error("Redirect without Location header");
    res = await fetch(new URL(loc, "https://texlive.net").href);
  }

  const buf = await res.arrayBuffer();

  const head = new Uint8Array(buf);
  const isPdf =
    head.length >= 4 &&
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46;

  if (!isPdf) {
    const log = new TextDecoder().decode(head);
    console.error("FULL LaTeX log â†“â†“â†“\n" + log);

    const markers = [
      "! ",
      "Undefined control sequence",
      "Missing $ inserted",
      "Emergency stop",
      "Fatal error occurred",
    ];
    const firstIdx =
      markers
        .map((m) => log.indexOf(m))
        .filter((i) => i >= 0)
        .sort((a, b) => a - b)[0] ?? 0;

    const snippet = log.slice(firstIdx, Math.min(firstIdx + 1500, log.length));
    throw new Error(
      "LaTeX compile failed. See console for full log.\n\nERROR SNIPPET:\n" +
        snippet
    );
  }

  return buf;
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Main message handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// IMPORTANT: Exactly one listener; no duplicates.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return;

  if (msg.type === "OPEN_MINI_PANEL") {
    (async () => {
      try {
        const info = await injectOverlayIntoActiveTab();
        sendResponse?.({ ok: true, tabId: info?.tabId ?? null });
      } catch (err) {
        console.error("Failed to open mini overlay", err);
        sendResponse?.({
          ok: false,
          error: err?.message || "Unable to show status overlay.",
        });
      }
    })();
    return true;
  }

  if (msg.type !== "PROCESS_JD_PIPELINE") return;

  let generationToken = null;

  (async () => {
    const { jd, company, prompt, categoryId, selectedProjectIds } = msg.payload || {};
    const { resumeData: DB } = await chrome.storage.local.get("resumeData");

    if (!DB?.apikey) throw new Error("Missing API key in Options.");
    const category = DB.categories.find((c) => c.id === categoryId);
    if (!category || !category.latex)
      throw new Error("Selected category not found or has no LaTeX template.");

    generationToken = `gen_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    await mergePopupState({
      generationToken,
      generationStartedAt: Date.now(),
      status: "Building .tex + Planning + Rewriting + Compiling...",
      pdfB64: "",
      pdfFilename: "",
      generationInBackground: true,
    });

    // --- 1) Build LaTeX with dynamic Projects (marker first, fallback to section) ---
    let latex = category.latex;
    const selectedProjects = (DB.projects || []).filter((p) =>
      (selectedProjectIds || []).includes(p.id)
    );

    const projectLatexStrings = selectedProjects
      .map((p) => {
        const linkCmd = p.link
          ? ` \\href{\\detokenize{${p.link}}}{\\underline{Link}}`
          : "";
        const bullets = (p.bullets || [])
          .map((b) => `  \\item ${escapeLatex(b)}`)
          .join("\n");
        return `\\resumeProjectHeading
  {\\textbf{${escapeLatex(p.name || "")}}${linkCmd}}{${escapeLatex(
          p.dates || ""
        )}}
  \\begin{itemize}[leftmargin=10pt,itemsep=2pt,parsep=0pt,topsep=5pt,partopsep=0pt]
${bullets}
  \\end{itemize}
  \\vspace{-10pt}`;
      })
      .join("\n\\vspace{4pt}\n");

    const injectionMarker = "%PROJECTS WILL BE DYNAMICALLY INJECTED HERE";
    if (latex.includes(injectionMarker)) {
      latex = latex.replace(injectionMarker, projectLatexStrings);
    } else {
      const projectsSectionRegex =
        /(\\section\{Projects\}[\s\S]*?\\resumeSubHeadingListStart)([\s\S]*?)(\\resumeSubHeadingListEnd)/;
      if (latex.match(projectsSectionRegex)) {
        latex = latex.replace(
          projectsSectionRegex,
          `$1\n${projectLatexStrings}\n$3`
        );
      } else {
        console.warn(
          "Could not find a projects injection point (marker or section)."
        );
      }
    }

   // --- 2) Refinement pipeline ---
const apikey = DB.apikey;

// Normalize category keywords (string or array)
const categoryKeywords = Array.isArray(category.keywords)
  ? category.keywords
  : String(category.keywords || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

// Extract JD gaps using category hints
const { skillsMissing, importantMissing } = await geminiExtractMissing(
  apikey,
  jd,
  categoryKeywords
);
console.log(" Extracted missing skills:", skillsMissing);
console.log(" Extracted important missing keywords:", importantMissing);

// Build targeting lists (JD-first so the model pivots aggressively to the JD)
const inResumeKeywords = collectResumeSkillKeywords(latex); // from Skills section
const targetKeywords = Array.from(
  new Set([
    ...skillsMissing,        // JD-derived, highest priority
    ...importantMissing,     // JD-derived high-impact concepts
    ...categoryKeywords,     // category hints, lowest priority
  ])
).filter(Boolean);

// Pass 1: role-aware bullet rewrites (applies to Work Experience + Projects)
const bulletOps = await geminiPlan(apikey, company, jd, prompt, latex, {
  targetKeywords,
  inResumeKeywords,
});
let finalLatex = applyOps(latex, bulletOps);


    // Pass 2: skills refinement
    const skillLabels = [
      "Programming Languages",
      "Frameworks & Libraries",
      "Databases",
      "Tools and Technologies",
      "Cloud & DevOps",
      "Development Practices",
      "Certifications",
    ];
    const skills = {};
    for (const lab of skillLabels) {
      const line = extractSkillLine(finalLatex, lab);
      if (line) {
        skills[lab] = stripLatex(line.items);
      }
    }
    const skillOps = await geminiRefineSkills(apikey, jd, skills, skillsMissing);
    finalLatex = applyOps(finalLatex, skillOps);

    // Fix common LaTeX pitfalls before compiling
    finalLatex = fixCommonLatexBugs(finalLatex);

    // --- 3) Compile & return ---
    console.log("--- FINAL LATEX SOURCE TO BE COMPILED ---\n\n", finalLatex);
    const pdfBuf = await compileToPdf(finalLatex, category.clsFileContent);
    const pdfB64 = arrayBufferToBase64(pdfBuf);
    const companySlug =
      (company || "").trim().replace(/\s+/g, "_") || "Generated";
    const downloadName = `Vipul_Charugundla_${companySlug}.pdf`;

    await mergePopupState(
      {
        status: "PDF ready!",
        pdfB64,
        pdfFilename: downloadName,
        generationToken: null,
        generationInBackground: false,
        lastGeneratedAt: Date.now(),
      },
      { token: generationToken }
    );

    sendResponse({ pdfB64, tex: finalLatex });
  })()
    .catch(async (err) => {
      console.error("PIPELINE FAILED:", err);
      const message = err?.message || "Unexpected error. See console.";
      await mergePopupState(
        {
          status: message,
          pdfB64: "",
          pdfFilename: "",
          generationToken: null,
          generationInBackground: false,
          lastErrorAt: Date.now(),
        },
        { token: generationToken }
      );
      sendResponse({ error: message });
    });

  return true; // keep the message channel open for async sendResponse
});

