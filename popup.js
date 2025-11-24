// popup.js (drop-in replacement)
(() => {
  const $ = (id) => document.getElementById(id);
  let DB = { categories: [], projects: [] };

  const POPUP_STATE_KEY = "popupState";
  const DEFAULT_STATE = {
    activeTab: "resume", // "resume" or "coverLetter"
    company: "",
    location: "",
    jd: "",
    prompt: "",
    categoryId: "",
    selectedProjectIds: [],
    pdfB64: "",
    pdfFilename: "",
    status: "",
    generationInBackground: false,
    // Cover Letter specific
    clCompanyDetails: "",
    clPdfB64: "",
    clPdfFilename: "",
    clText: ""
  };

  let popupState = { ...DEFAULT_STATE };
  let currentBlobUrl = "";
  let currentClBlobUrl = "";
  let persistTimer = 0;

  const hide = (el) => {
    if (!el) return;
    el.style.display = "none";
    el.removeAttribute("href");
  };

  const revokeBlobUrl = () => {
    if (currentBlobUrl && currentBlobUrl.startsWith("blob:")) {
      URL.revokeObjectURL(currentBlobUrl);
    }
    currentBlobUrl = "";
  };

  const revokeClBlobUrl = () => {
    if (currentClBlobUrl && currentClBlobUrl.startsWith("blob:")) {
      URL.revokeObjectURL(currentClBlobUrl);
    }
    currentClBlobUrl = "";
  };

  const persistState = (immediate = false) => {
    const write = () =>
      chrome.storage.local
        .set({ [POPUP_STATE_KEY]: popupState })
        .catch((err) => console.error("Failed to persist popup state", err));

    if (immediate) {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = 0;
      write();
      return;
    }

    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = 0;
      write();
    }, 250);
  };

  const updateState = (partial, { flush = false } = {}) => {
    popupState = { ...popupState, ...partial };
    persistState(flush);
  };

  const loadPopupState = async () => {
    try {
      const stored = await chrome.storage.local.get(POPUP_STATE_KEY);
      if (stored && stored[POPUP_STATE_KEY]) {
        popupState = { ...DEFAULT_STATE, ...stored[POPUP_STATE_KEY] };
      }
    } catch (err) {
      console.warn("Unable to load popup state", err);
    }
  };

  const populateCategories = () => {
    const select = $("categorySelect");
    select.innerHTML = `<option value="">-- Select a Category --</option>`;
    DB.categories.forEach((cat) => {
      select.innerHTML += `<option value="${cat.id}">${cat.name}</option>`;
    });
  };

  const populateProjects = (categoryId) => {
    const container = $("projectSelection");
    const relevantProjects = DB.projects.filter((p) => p.categoryIds.includes(categoryId));

    if (!relevantProjects.length) {
      container.innerHTML = `<p class="muted">No projects linked to this category.</p>`;
      return;
    }

    container.innerHTML = relevantProjects
      .map(
        (proj) => `
      <label>
        <input type="checkbox" class="project-checkbox" value="${proj.id}" checked>
        ${proj.name}
      </label>
    `
      )
      .join("");
  };

  const hydratePdfLink = (pdfLink, b64, filename, isCl = false) => {
    if (!pdfLink) return;
    if (isCl) revokeClBlobUrl(); else revokeBlobUrl();

    if (!b64) {
      hide(pdfLink);
      return;
    }

    try {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      if (isCl) currentClBlobUrl = blobUrl; else currentBlobUrl = blobUrl;

      pdfLink.href = blobUrl;
      pdfLink.download = filename || (isCl ? "Cover_Letter.pdf" : "Resume.pdf");
      pdfLink.style.display = "inline-block";
    } catch (err) {
      console.error("Failed to restore PDF from state", err);
      hide(pdfLink);
      if (isCl) updateState({ clPdfB64: "", clPdfFilename: "" });
      else updateState({ pdfB64: "", pdfFilename: "" });
    }
  };

  const syncSelectedProjects = () => {
    const ids = Array.from(
      document.querySelectorAll(".project-checkbox:checked"),
      (el) => el.value
    );
    updateState({ selectedProjectIds: ids });
  };

  const clRoleInput = $("clRole");
  const clJdInput = $("clJd");

  const switchTab = (tabName) => {
    const resumeView = $("resumeView");
    const coverLetterView = $("coverLetterView");
    const tabResume = $("tabResume");
    const tabCoverLetter = $("tabCoverLetter");

    if (tabName === "coverLetter") {
      resumeView.style.display = "none";
      coverLetterView.style.display = "block";
      tabResume.classList.remove("active");
      tabCoverLetter.classList.add("active");

      // Always sync Role from current category
      const cat = DB.categories.find(c => c.id === popupState.categoryId);
      if (cat) {
        clRoleInput.value = cat.name;
        updateState({ clRole: cat.name });
      } else {
        clRoleInput.value = "No Category Selected";
        updateState({ clRole: "" });
      }

      if (!popupState.clJd) {
        if (popupState.jd) {
          clJdInput.value = popupState.jd;
          updateState({ clJd: popupState.jd });
        }
      }

    } else {
      resumeView.style.display = "block";
      coverLetterView.style.display = "none";
      tabResume.classList.add("active");
      tabCoverLetter.classList.remove("active");
    }
    updateState({ activeTab: tabName });
  };

  document.addEventListener("DOMContentLoaded", async () => {
    DB = await chrome.storage.local.get("resumeData").then((v) => v.resumeData || DB);

    populateCategories();

    const statusEl = $("status");
    const companyInput = $("company");
    const locationInput = $("location");
    const jdInput = $("jd");
    const promptInput = $("prompt");
    const categorySelect = $("categorySelect");
    const projectContainer = $("projectSelection");
    const pdfLink = $("downloadPdf");
    const generateBtn = $("generate");
    // Close button removed

    // Cover Letter Elements
    const tabResume = $("tabResume");
    const tabCoverLetter = $("tabCoverLetter");
    const clCompanyDetails = $("clCompanyDetails");
    const generateClBtn = $("generateCoverLetter");
    const clPdfLink = $("downloadCoverLetter");
    const copyClBtn = $("copyCoverLetter");

    await loadPopupState();

    const applyStateToDom = () => {
      companyInput.value = popupState.company || "";
      const resolvedLocation = popupState.location || DB.location || "";
      locationInput.value = resolvedLocation;
      if (!popupState.location && DB.location) {
        updateState({ location: DB.location });
      }
      jdInput.value = popupState.jd || "";
      promptInput.value = popupState.prompt || "";
      clCompanyDetails.value = popupState.clCompanyDetails || "";
      clRoleInput.value = popupState.clRole || "";
      clJdInput.value = popupState.clJd || "";

      const validCategory = DB.categories.some((cat) => cat.id === popupState.categoryId);
      if (validCategory) {
        categorySelect.value = popupState.categoryId;
        populateProjects(popupState.categoryId);
        // Ensure clRole is synced on load
        const cat = DB.categories.find(c => c.id === popupState.categoryId);
        if (cat) clRoleInput.value = cat.name;
      } else {
        categorySelect.value = "";
        projectContainer.innerHTML = `<p class="muted">Select a category first.</p>`;
        updateState({ categoryId: "", selectedProjectIds: [] });
      }

      const checkboxes = document.querySelectorAll(".project-checkbox");
      const storedIds = popupState.selectedProjectIds || [];
      if (checkboxes.length) {
        const shouldDefaultAll = !storedIds.length;
        const activeIds = [];
        checkboxes.forEach((box) => {
          const checked = shouldDefaultAll || storedIds.includes(box.value);
          box.checked = checked;
          if (checked) activeIds.push(box.value);
        });
        if (shouldDefaultAll && activeIds.length) {
          updateState({ selectedProjectIds: activeIds });
        }
      }

      statusEl.textContent = popupState.status || "";
      switchTab(popupState.activeTab || "resume");

      if (popupState.clText) {
        copyClBtn.style.display = "inline-block";
      } else {
        copyClBtn.style.display = "none";
      }
    };

    applyStateToDom();
    hydratePdfLink(pdfLink, popupState.pdfB64, popupState.pdfFilename);
    hydratePdfLink(clPdfLink, popupState.clPdfB64, popupState.clPdfFilename, true);

    tabResume.addEventListener("click", () => switchTab("resume"));
    tabCoverLetter.addEventListener("click", () => switchTab("coverLetter"));

    categorySelect.addEventListener("change", (e) => {
      const catId = e.target.value;
      updateState({ categoryId: catId });

      if (catId) {
        populateProjects(catId);
        document
          .querySelectorAll(".project-checkbox")
          .forEach((box) => {
            box.checked = true;
          });
        syncSelectedProjects();

        // Always sync role to CL
        const cat = DB.categories.find(c => c.id === catId);
        if (cat) {
          updateState({ clRole: cat.name });
          clRoleInput.value = cat.name;
        }

      } else {
        projectContainer.innerHTML = `<p class="muted">Select a category first.</p>`;
        updateState({ selectedProjectIds: [] });
      }

      updateState({ pdfB64: "", pdfFilename: "" }, { flush: true });
      hide(pdfLink);
      revokeBlobUrl();
    });

    projectContainer.addEventListener("change", (e) => {
      if (e.target.classList.contains("project-checkbox")) {
        syncSelectedProjects();
      }
    });

    $("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());

    const handleInput = (input, key) => {
      input.addEventListener("input", () => updateState({ [key]: input.value }));
    };

    handleInput(companyInput, "company");
    handleInput(locationInput, "location");
    handleInput(jdInput, "jd");
    handleInput(promptInput, "prompt");
    handleInput(clCompanyDetails, "clCompanyDetails");
    handleInput(clJdInput, "clJd");

    // Always sync JD to CL when Resume JD changes
    jdInput.addEventListener("input", () => {
      updateState({ clJd: jdInput.value });
      clJdInput.value = jdInput.value;
    });

    // Dual-download binding to keep two filenames in sync
    if (pdfLink && !pdfLink.dataset.dual) {
      pdfLink.addEventListener("click", (ev) => {
        if (!pdfLink.href) return;

        ev.preventDefault();

        const href = pdfLink.href;
        const firstName = pdfLink.download || "Vipul_Charugundla_generated.pdf";
        const secondName = "Vipul_Charugundla.pdf";

        const triggerDownload = (name) => {
          const a = document.createElement("a");
          a.href = href;
          a.download = name;
          a.style.display = "none";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        };

        triggerDownload(firstName);
        triggerDownload(secondName);
      });
      pdfLink.dataset.dual = "1";
    }

    if (copyClBtn) {
      copyClBtn.addEventListener("click", () => {
        if (popupState.clText) {
          navigator.clipboard.writeText(popupState.clText).then(() => {
            const originalText = copyClBtn.textContent;
            copyClBtn.textContent = "Copied!";
            setTimeout(() => {
              copyClBtn.textContent = originalText;
            }, 2000);
          }).catch(err => {
            console.error("Failed to copy text: ", err);
            statusEl.textContent = "Failed to copy text.";
          });
        }
      });
    }

    generateBtn.addEventListener("click", async () => {
      const company = companyInput.value.trim();
      const location = locationInput.value.trim();
      const jd = jdInput.value.trim();
      const categoryId = categorySelect.value;
      const selectedProjectIds = Array.from(
        document.querySelectorAll(".project-checkbox:checked"),
        (el) => el.value
      );

      if (!categoryId) {
        statusEl.textContent = "Please select a category.";
        updateState({ status: statusEl.textContent }, { flush: true });
        return;
      }
      if (!company) {
        statusEl.textContent = "Please enter a Company Name.";
        updateState({ status: statusEl.textContent }, { flush: true });
        return;
      }
      if (!jd) {
        statusEl.textContent = "Please paste a Job Description.";
        updateState({ status: statusEl.textContent }, { flush: true });
        return;
      }

      revokeBlobUrl();
      hide(pdfLink);

      const prevText = generateBtn.textContent;
      generateBtn.disabled = true;
      generateBtn.textContent = "Working...";
      statusEl.textContent = "Building .tex + Planning + Rewriting + Compiling...";
      updateState(
        {
          status: statusEl.textContent,
          company,
          location,
          jd,
          prompt: promptInput.value.trim(),
          categoryId,
          selectedProjectIds,
          pdfB64: "",
          pdfFilename: "",
          generationInBackground: true
        },
        { flush: true }
      );

      try {
        const resp = await chrome.runtime.sendMessage({
          type: "PROCESS_JD_PIPELINE",
          payload: {
            jd,
            company,
            location,
            prompt: promptInput.value.trim(),
            categoryId,
            selectedProjectIds
          }
        });

        if (!resp || !resp.pdfB64) {
          statusEl.textContent =
            "Compile failed. Check background console for LaTeX errors.";
          updateState(
            { status: statusEl.textContent, pdfB64: "", pdfFilename: "" },
            { flush: true }
          );
          return;
        }

        const bytes = Uint8Array.from(atob(resp.pdfB64), (c) => c.charCodeAt(0));
        const pdfBlob = new Blob([bytes], { type: "application/pdf" });
        revokeBlobUrl();
        currentBlobUrl = URL.createObjectURL(pdfBlob);

        pdfLink.href = currentBlobUrl;
        const downloadName = `Vipul_Charugundla_${company.replace(/\s+/g, "_")}.pdf`;
        pdfLink.download = downloadName;
        pdfLink.style.display = "inline-block";
        statusEl.textContent = "PDF ready!";

        updateState(
          {
            pdfB64: resp.pdfB64,
            pdfFilename: downloadName,
            status: statusEl.textContent,
            generationInBackground: false
          },
          { flush: true }
        );
      } catch (err) {
        console.error(err);
        const message = err?.message || "Unexpected error. See console.";
        statusEl.textContent = message;
        updateState(
          { pdfB64: "", pdfFilename: "", status: message, generationInBackground: false },
          { flush: true }
        );
      } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = prevText;
      }
    });

    generateClBtn.addEventListener("click", async () => {
      const company = companyInput.value.trim();
      const location = locationInput.value.trim();
      const jd = clJdInput.value.trim(); // Use the CL JD input
      const categoryId = categorySelect.value;
      const clDetails = clCompanyDetails.value.trim();
      const selectedProjectIds = Array.from(
        document.querySelectorAll(".project-checkbox:checked"),
        (el) => el.value
      );

      if (!categoryId) {
        statusEl.textContent = "Please select a category in Resume tab.";
        updateState({ status: statusEl.textContent }, { flush: true });
        return;
      }
      if (!company) {
        statusEl.textContent = "Please enter a Company Name in Resume tab.";
        updateState({ status: statusEl.textContent }, { flush: true });
        return;
      }
      if (!jd) {
        statusEl.textContent = "Please paste a Job Description.";
        updateState({ status: statusEl.textContent }, { flush: true });
        return;
      }

      revokeClBlobUrl();
      hide(clPdfLink);
      hide(copyClBtn);

      const prevText = generateClBtn.textContent;
      generateClBtn.disabled = true;
      generateClBtn.textContent = "Working...";
      statusEl.textContent = "Generating Cover Letter...";
      updateState(
        {
          status: statusEl.textContent,
          clCompanyDetails: clDetails,
          clPdfB64: "",
          clPdfFilename: "",
          clText: "",
          generationInBackground: true
        },
        { flush: true }
      );

      try {
        const resp = await chrome.runtime.sendMessage({
          type: "PROCESS_COVER_LETTER",
          payload: {
            jd,
            company,
            location,
            clDetails,
            categoryId,
            selectedProjectIds
          }
        });

        if (!resp || !resp.pdfB64) {
          statusEl.textContent = "Cover Letter generation failed. See console.";
          updateState(
            { status: statusEl.textContent, clPdfB64: "", clPdfFilename: "" },
            { flush: true }
          );
          return;
        }

        const bytes = Uint8Array.from(atob(resp.pdfB64), (c) => c.charCodeAt(0));
        const pdfBlob = new Blob([bytes], { type: "application/pdf" });
        revokeClBlobUrl();
        currentClBlobUrl = URL.createObjectURL(pdfBlob);

        clPdfLink.href = currentClBlobUrl;
        const downloadName = `CoverLetter_Vipul_${company.replace(/\s+/g, "_")}.pdf`;
        clPdfLink.download = downloadName;
        clPdfLink.style.display = "inline-block";

        copyClBtn.style.display = "inline-block";

        statusEl.textContent = "Cover Letter ready!";

        updateState(
          {
            clPdfB64: resp.pdfB64,
            clPdfFilename: downloadName,
            clText: resp.coverLetterText,
            status: statusEl.textContent,
            generationInBackground: false
          },
          { flush: true }
        );
      } catch (err) {
        console.error(err);
        const message = err?.message || "Unexpected error. See console.";
        statusEl.textContent = message;
        updateState(
          { clPdfB64: "", clPdfFilename: "", clText: "", status: message, generationInBackground: false },
          { flush: true }
        );
      } finally {
        generateClBtn.disabled = false;
        generateClBtn.textContent = prevText;
      }
    });

  });
})();
