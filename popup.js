(() => {
    const $ = id => document.getElementById(id);
    let DB = { categories: [], projects: [] };

    const hide = (el) => { if(el) { el.style.display = "none"; el.removeAttribute("href"); } };

    const populateCategories = () => {
        const select = $("categorySelect");
        select.innerHTML = `<option value="">-- Select a Category --</option>`;
        DB.categories.forEach(cat => {
            select.innerHTML += `<option value="${cat.id}">${cat.name}</option>`;
        });
    };

    const populateProjects = (categoryId) => {
        const container = $("projectSelection");
        const relevantProjects = DB.projects.filter(p => p.categoryIds.includes(categoryId));
        
        if (!relevantProjects.length) {
            container.innerHTML = `<p class="muted">No projects linked to this category.</p>`;
            return;
        }

        container.innerHTML = relevantProjects.map(proj => `
            <label>
                <input type="checkbox" class="project-checkbox" value="${proj.id}" checked>
                ${proj.name}
            </label>
        `).join("");
    };

    document.addEventListener("DOMContentLoaded", async () => {
        DB = await chrome.storage.local.get("resumeData").then(v => v.resumeData || DB);
        
        populateCategories();

        $("categorySelect").addEventListener("change", (e) => {
            const catId = e.target.value;
            if (catId) {
                populateProjects(catId);
            } else {
                $("projectSelection").innerHTML = `<p class="muted">Select a category first.</p>`;
            }
        });

        $("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
        
        const generateBtn = $("generate");
        generateBtn.addEventListener("click", async () => {
            const statusEl = $("status");
            const company = $("company").value.trim();
            const jd = $("jd").value.trim();
            const categoryId = $("categorySelect").value;
            const selectedProjectIds = Array.from(document.querySelectorAll(".project-checkbox:checked")).map(el => el.value);

            // Validation
            if (!categoryId) { statusEl.textContent = "Please select a category."; return; }
            if (!company) { statusEl.textContent = "Please enter a Company Name."; return; }
            if (!jd) { statusEl.textContent = "Please paste a Job Description."; return; }

            const pdfLink = $("downloadPdf");
            if (pdfLink.href?.startsWith("blob:")) URL.revokeObjectURL(pdfLink.href);
            hide(pdfLink);
            
            const prevText = generateBtn.textContent;
            generateBtn.disabled = true;
            generateBtn.textContent = "Working…";
            statusEl.textContent = "Building .tex → Planning → Rewriting → Compiling…";

            try {
                const resp = await chrome.runtime.sendMessage({
                    type: "PROCESS_JD_PIPELINE",
                    payload: {
                        jd,
                        prompt: $("prompt").value.trim(),
                        categoryId,
                        selectedProjectIds
                    }
                });

                if (!resp || !resp.pdfB64) {
                    statusEl.textContent = "Compile failed. Check background console for LaTeX errors.";
                    return;
                }

                const bytes = Uint8Array.from(atob(resp.pdfB64), c => c.charCodeAt(0));
                const pdfUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));

                pdfLink.href = pdfUrl;
                pdfLink.download = `Vipul_Charugundla_${company.replace(/\s+/g, '_')}.pdf`;
                pdfLink.style.display = "inline-block";
                statusEl.textContent = "✅ PDF ready!";
            } catch (e) {
                console.error(e);
                statusEl.textContent = e?.message || "Unexpected error. See console.";
            } finally {
                generateBtn.disabled = false;
                generateBtn.textContent = prevText;
            }
        });
    });
})();