// MV3 background service worker (type: module)

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
    if (txt.startsWith("```")) {
        txt = txt.replace(/^(?:```(?:json)?\s*)|(?:\s*```)$/g, "").trim();
    }
    if (!txt.startsWith("{")) {
        const first = txt.indexOf("{");
        const last = txt.lastIndexOf("}");
        if (first === -1 || last === -1 || last <= first) return null;
        txt = txt.slice(first, last + 1);
    }
    try {
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
    const prompt = `You are an AI assistant that refines resume skill sections to match a job description. Your task is to take the user's current skill lines, a job description, and a mandatory list of skills, then generate a JSON array of 'replace_skill_csv' operations. ONLY return skills in plain text, do not add any LaTeX formatting like \\textbf{}.

## JSON OUTPUT SPECIFICATION
- Your entire response MUST be a single raw JSON object. Do not add markdown wrappers.
- The root of the object must be a key "ops" containing an array of objects.
- Each object must have this structure: { "op": "replace_skill_csv", "label": "string", "csv": "string" }

## PROCESSING LOGIC
1. **Incorporate Mandatory Skills**: For EACH skill in the "Mandatory Skills to Include" list, determine the most appropriate skill line and add it to that line's CSV.
2. **Refine Existing Skills**: Analyze the job description and subtly re-order existing skills.
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
    // CORRECTED MODEL NAME
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
{ "skills": ["string"], "important": ["string"] }

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
    // CORRECTED MODEL NAME
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
    // UPDATED: Added a rule to prevent the AI from generating LaTeX commands.
    const refinedPolicy = `You are an expert resume editor specializing in ATS optimization. Enhance the user's existing resume bullet points to be more impactful while adhering to all rules.

## STRICT RULES
1. **Plain Text Only**: Your output for each bullet MUST be plain text. Do NOT include any LaTeX commands like \\textbf{}, \\textit{}, etc.
2. **Word Count Windows**: Each rewritten bullet MUST fall within its specific word count window.
3. **Weave in Keywords**: In each bullet, include one or two words from the 'Important Words' list.
4. **Preserve Core Meaning**: Keep the original intent. All numbers, metrics, and proper nouns must be preserved.
5. **Maintain Structure**: Do NOT add, delete, or reorder bullets.

## OUTPUT FORMAT
Return a single, raw JSON object using the 'replace_bullets' operation.`;

    const instructionBlock = userPrompt?.trim() ? `## USER PROMPT (Highest Priority)\n${userPrompt.trim()}\n` : "";
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
    const obj = safeJsonFromGemini(data?.candidates?.[0]?.content?.parts?.[0]?.text || "");
    const sectionMap = Object.fromEntries(targetSections.map(s => [s.name.toLowerCase(), s]));
    return reconcileBulletCounts(obj.ops, sectionMap);
}
// ===== LaTeX Parsers & Manipulators =====
function findSubsections(tex) {
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

function findProjectSections(tex) {
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

function allRewriteableSections(tex) {
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

function applyOps(tex, ops) {
    let out = tex;
    const sectionsCache = allRewriteableSections(out);
    const secByName = (name) => sectionsCache.find(s => s.name.toLowerCase() === cleanName(name).toLowerCase());

    for (const op of (ops || [])) {
        try {
            if (op.op === "replace_bullets") {
                const sec = secByName(op.section);
                if (!sec) continue;

                // UPDATED: More robustly sanitizes bullets, removing the old stripBold() call.
                const sanitizedBullets = op.bullets.map(b => {
                    const plainText = String(b).replace(/\\textbf{/g, '').replace(/}/g, '');
                    return escapeLatex(plainText);
                });
                out = replaceSectionBullets(out, sec.name, sanitizedBullets);

            } else if (op.op === "replace_skill_csv") {
                if (!op.label || !op.csv) continue;
                const sanitizedCsv = op.csv.replace(/\\textbf{/g, '').replace(/}/g, '');
                out = replaceSkillLine(out, op.label, escapeLatex(sanitizedCsv));
            }
        } catch (e) {
            console.warn("Failed to apply op", op, e);
        }
    }
    return out;
}
// ===== PDF Compilation & Final Utilities =====
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

    let res = await fetch("[https://texlive.net/cgi-bin/latexcgi](https://texlive.net/cgi-bin/latexcgi)", { method: "POST", body: fd });
    if (res.status === 301 || res.status === 302) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error("Redirect without Location header");
        res = await fetch(new URL(loc, "[https://texlive.net](https://texlive.net)").href);
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
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// ===== Main Message Handler (SINGLE CORRECT VERSION) =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
        if (msg.type !== "PROCESS_JD_PIPELINE") return;

        const { jd, prompt, categoryId, selectedProjectIds } = msg.payload || {};
        const { resumeData: DB } = await chrome.storage.local.get("resumeData");

        if (!DB?.apikey) throw new Error("Missing API key in Options.");
        const category = DB.categories.find(c => c.id === categoryId);
        if (!category || !category.latex) throw new Error("Selected category not found or has no LaTeX template.");

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

        const injectionMarker = "%PROJECTS WILL BE DYNAMICALLY INJECTED HERE";
        if (latex.includes(injectionMarker)) {
            latex = latex.replace(injectionMarker, projectLatexStrings);
        } else {
            console.warn("Could not find project injection marker. Check your LaTeX template for '%PROJECTS WILL BE DYNAMICALLY INJECTED HERE'");
        }

        const apikey = DB.apikey;
        const keywords = Array.isArray(category.keywords) ? category.keywords : [];
        const { skillsMissing, importantMissing } = await geminiExtractMissing(apikey, jd, keywords);

        const bulletOps = await geminiPlan(apikey, jd, prompt, latex, { importantMissing });
        let finalLatex = applyOps(latex, bulletOps);

        const skillLabels = ["Programming Languages", "Frameworks and Libraries", "Databases", "Tools and Technologies", "Cloud Platforms and Deployment", "Software Development Practices", "Certifications"];
        const skills = {};
        for (const lab of skillLabels) {
            const line = extractSkillLine(finalLatex, lab);
            if (line) skills[lab] = line.items;
        }
        const skillOps = await geminiRefineSkills(apikey, jd, skills, skillsMissing);
        finalLatex = applyOps(finalLatex, skillOps);

        const pdfBuf = await compileToPdf(finalLatex, category.clsFileContent);
        const pdfB64 = arrayBufferToBase64(pdfBuf);
        sendResponse({ pdfB64, tex: finalLatex });

    })().catch(err => {
        console.error("PIPELINE FAILED:", err);
        sendResponse({ error: err.message });
    });
    return true; // Required for async sendResponse
});