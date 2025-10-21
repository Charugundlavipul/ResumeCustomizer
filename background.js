// MV3 background service worker — cleaned, hardened, and drop-in ready

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


/** ───────────────────────────────── CONFIG ─────────────────────────────────
 * How should the model return bullets?
 * - "TEXT": model returns plain text (no LaTeX). We escape safely on-device.  ← recommended
 * - "LATEX": model returns already LaTeX-safe text (no \item or environments), we trust it.
 */
const GEMINI_BULLET_FORMAT = "TEXT"; // "TEXT" | "LATEX"

/** Strictly keep bullet counts; no visible suffix, no metric appenders */
const ENFORCE_METRIC_VISIBILITY = false; // never append "(retained metrics: ...)" text

// ───────────────────────────────── Utilities ─────────────────────────────────

// Only strip stray *markdown* bold, not LaTeX commands.
const stripBold = (s) => String(s || "").replace(/\*(\S(?:.*?\S)?)\*/g, "$1");

// ── NEW: robust bullet extractor used everywhere (prevents last-item drop)
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
    .replace(/\s*\(\d+\s+words?\)\s*$/i, "")
    .replace(/\s*\(retained metrics:[^)]+\)\s*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

// Remove simple LaTeX commands like \textbf{...} -> keep inner text
const stripLatex = (s) => {
  if (!s) return "";
  return String(s).replace(/\\textbf\{([^}]+)\}/g, "$1");
};

// Safer JSON un-fencer for Gemini responses
function safeJsonFromGemini(raw) {
  if (!raw) return null;
  let txt = String(raw).trim();

  // Strip code fences if present
  if (txt.startsWith("```")) {
    txt = txt.replace(/^(?:```(?:json)?\s*)|(?:\s*```)$/g, "").trim();
  }

  // Seek the first {...} or [...] blob if the model wrapped text around it
  if (!/^[{\[]/.test(txt)) {
    const first = txt.search(/[{\[]/);
    const lastObj = txt.lastIndexOf("}");
    const lastArr = txt.lastIndexOf("]");
    const last = Math.max(lastObj, lastArr);
    if (first === -1 || last === -1 || last <= first) return null;
    txt = txt.slice(first, last + 1);
  }

  // 🔧 KEY PATCH: make JSON-valid escapes
  // Any backslash not starting a legal JSON escape becomes a double backslash.
  // Fixes \% \& \_ \{ \} \$ \# etc that LLMs emit for LaTeX.
  txt = txt.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");

  // Also remove a UTF-8 BOM if present
  txt = txt.replace(/^\uFEFF/, "");

  try {
    return JSON.parse(txt);
  } catch (e) {
    console.warn("safeJsonFromGemini failed to parse JSON after sanitize:", e, txt);
    return null;
  }
}


// Hardened parser wrapper that always returns { ops: [] } on failure
async function robustGeminiParse(resp) {
  const raw = resp?.trim?.() || "";
  const parsed = safeJsonFromGemini(raw);
  if (parsed?.ops && Array.isArray(parsed.ops)) return parsed;

  console.error(
    "🔴 GEMINI reply could not be parsed into a valid {ops: []} structure ↓↓↓\n" +
      raw
  );
  return { ops: [] };
}

function formatSectionDump(sections, maxChars = 7000) {
  let out = "";
  for (const s of sections) {
    out += `▼ ${s.name} (${s.bullets.length})\n`;
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

// ───────────────────────────── Gemini API callers ─────────────────────────────

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
4. While modifying csv array if you fell the tool is not at all relevant to any of the jd's requirement then you can remove that tool from the final answer you can only remove maximum of 4 items in the entire skills section.

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
      topP: 0.9,
      maxOutputTokens: 4000,
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
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
      maxOutputTokens: 2000,
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
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

/** ── NEW: collect verified skills from the resume to keep substitutions truthful */
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
  const MIN_WORDS = 34;
  const MAX_WORDS = 36;

  const formatHint =
    GEMINI_BULLET_FORMAT === "LATEX"
      ? `Return bullets that are LaTeX-safe text, but DO NOT include LaTeX list commands (no "\\item", no "itemize" blocks).`
      : `Return bullets as plain natural-language text with NO LaTeX markup.`;

  const tgt = (targetKeywords || []).filter(Boolean).slice(0, 80).join(", ");
  const verified = (inResumeKeywords || []).filter(Boolean).slice(0, 160).join(", ");

  // ───────── JD-ONLY LEXICON + DEVIATION ALLOWED (TRUTHFUL) ─────────
  const refinedPolicy = `
As an AI resume editor, your task is to rewrite resume bulletsRewrite each resume bullet so it precisely maps to the provided Job Description (JD) while preserving the original meaning and facts.

Non-Negotiables

JD First: Mirror the JD’s responsibilities, terminology, and tech stack; prefer the most emphasized tools/frameworks in the JD when multiple are listed.

STRICT: No ${company}: Do not include the word ${company} and omit any employer-specific/internal tools.

Structure Lock: Keep the exact number of bullets per section and preserve their order.

Length Gate: Every bullet must be between ${MIN_WORDS} and ${MAX_WORDS} words.

Fact Integrity: Keep all facts; if a bullet contains metrics, create an additional bullet that integrates the metric and aligns it to the JD.

Quality Bar: Only replace a bullet if the new version is more optimized; otherwise, retain the original.

Tool Emphasis: When the JD lists multiple technologies, prioritize the one most stressed in the JD.

Uniqueness Constraint: Do not repeat the same skill/technology across bullets; if a tool cannot be woven in without duplication, keep the existing bullet.

Global Repetition Cap: Ensure tools/technologies do not appear more than twice across the entire rewritten set.

Style Rules

One sentence per bullet, dense and information-rich.

Start with a strong action verb (e.g., Architected, Automated, Orchestrated, Optimized).

No filler (avoid terms like “successfully,” “various,” “multiple”).

Be exacting: Specify versions and configurations where relevant (e.g., “React 18,” “Python 3.11,” “PostgreSQL 14,” “Kubernetes 1.30”).

No generalities: Prefer concrete scope, scale, and impact details consistent with the source bullet.

Transformation Rules

Map to JD: Replace original terminology with JD vocabulary while preserving the underlying achievement.

Integrate Metrics: If any metric exists, add a separate bullet tying the metric to JD outcomes (performance, reliability, cost, security, UX, etc.).

Optimize, Don’t Inflate: Tighten phrasing, clarify outcomes, and align tools—never invent facts.

Avoid Duplication: Enforce the no-repeat rule for skills/tech across all bullets; if conflict arises, keep the original bullet unmodified.

Final Pass: Confirm all bullets meet word count, order, JD alignment, fact preservation, and repetition limits.

Output Requirements

Return the bullets in the original section order and count.

Each bullet: ${MIN_WORDS}–${MAX_WORDS} words, one sentence, action-led, JD-aligned, and fact-accurate.

Include extra metric bullets only when the source bullet contains metrics, ensuring they also follow all rules above.

Never ever end a sentence with fillers like ""aligning with" etc
`;

  const instructionBlock = userPrompt?.trim()
    ? `## USER PROMPT (Respect the spirit if provided)\n${userPrompt.trim()}\n`
    : "";

  const targetSections = allRewriteableSections(tex);
  if (!targetSections.length) return [];

  const sectionsDump = formatSectionDump(targetSections);

  const windowReminder = targetSections
    .map(sec => sec.bullets.map(() => `${MIN_WORDS}-${MAX_WORDS}`).join(", "))
    .join("; ");

  const schema =
    'Return STRICT JSON ONLY:\n{"ops":[{"op":"replace_bullets","section":"Section Name","bullets":["...", "..."]}]}';

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
${String(jd).slice(0, 5000)}

### TARGET ROLE STACK (from JD/Category) — prioritize these:
${tgt || "None"}

### Current Bullets (keep same COUNT & ORDER; rewrite EACH to ${MIN_WORDS}-${MAX_WORDS} words; PRESERVE existing metrics):
${sectionsDump}

### Required word-count window for each bullet (by position):
[${windowReminder}]

## OUTPUT FORMAT
${schema}`.trim(),
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.15,
      topP: 0.8,
      maxOutputTokens: 5000,
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(
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


// ───────────────────────────── LaTeX helpers ─────────────────────────────

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
    .split(/\n(?=(?:[-–—•]|\d+\.)\s+)|(?<=;)\s+(?=[A-Z(])|(?:\s*\\item\s+)/g)
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
      ? String(s || "").replace(/\s*\(\d+\s+words?\)\s*$/i, "").replace(/\s*\(retained metrics:[^)]+\)\s*$/i, "").replace(/\s{2,}/g, " ").trim()
      : cleanBullet(s));

  return flat.map(finalize);
}

function splitMergedBulletText(s) {
  const t = String(s || "").trim();
  if (!t) return [""];
  const parts = t
    .split(/\s*(?:\\item\s+)|\n(?=(?:[-–—•]|\d+\.)\s+)/g)
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
      if (op.op === "replace_bullets") {
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

// ────────────────────────── PDF Compilation Utils ──────────────────────────

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
    console.error("FULL LaTeX log ↓↓↓\n" + log);

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

// ─────────────────────────── Main message handler ───────────────────────────

// IMPORTANT: Exactly one listener; no duplicates.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type !== "PROCESS_JD_PIPELINE") return;

    const { jd, company, prompt, categoryId, selectedProjectIds } = msg.payload || {};
    const { resumeData: DB } = await chrome.storage.local.get("resumeData");

    if (!DB?.apikey) throw new Error("Missing API key in Options.");
    const category = DB.categories.find((c) => c.id === categoryId);
    if (!category || !category.latex)
      throw new Error("Selected category not found or has no LaTeX template.");

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
console.log("🔍 Extracted missing skills:", skillsMissing);
console.log("🔍 Extracted important missing keywords:", importantMissing);

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
    sendResponse({ pdfB64, tex: finalLatex });
  })()
    .catch((err) => {
      console.error("PIPELINE FAILED:", err);
      sendResponse({ error: err.message });
    });

  return true; // keep the message channel open for async sendResponse
});
