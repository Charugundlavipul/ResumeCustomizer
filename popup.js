// popup.js (drop-in replacement)
(() => {
  const $ = (id) => document.getElementById(id);
  let DB = { categories: [], projects: [] };

  const POPUP_STATE_KEY = "popupState";
  const DEFAULT_STATE = {
    company: "",
    jd: "",
    prompt: "",
    categoryId: "",
    selectedProjectIds: [],
    pdfB64: "",
    pdfFilename: "",
    status: "",
    generationInBackground: false
  };

  let popupState = { ...DEFAULT_STATE };
  let currentBlobUrl = "";
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

  const hydratePdfLink = (pdfLink) => {
    if (!pdfLink) return;
    revokeBlobUrl();
    if (!popupState.pdfB64) {
      hide(pdfLink);
      return;
    }

    try {
      const bytes = Uint8Array.from(atob(popupState.pdfB64), (c) => c.charCodeAt(0));
      currentBlobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      pdfLink.href = currentBlobUrl;
      pdfLink.download = popupState.pdfFilename || "Vipul_Charugundla_generated.pdf";
      pdfLink.style.display = "inline-block";
    } catch (err) {
      console.error("Failed to restore PDF from state", err);
      hide(pdfLink);
      updateState({ pdfB64: "", pdfFilename: "" });
    }
  };

  const syncSelectedProjects = () => {
    const ids = Array.from(
      document.querySelectorAll(".project-checkbox:checked"),
      (el) => el.value
    );
    updateState({ selectedProjectIds: ids });
  };

  document.addEventListener("DOMContentLoaded", async () => {
    DB = await chrome.storage.local.get("resumeData").then((v) => v.resumeData || DB);

    populateCategories();

    const statusEl = $("status");
    const companyInput = $("company");
    const jdInput = $("jd");
    const promptInput = $("prompt");
    const categorySelect = $("categorySelect");
    const projectContainer = $("projectSelection");
    const pdfLink = $("downloadPdf");
    const generateBtn = $("generate");
    const closeBtn = $("closePopup");

    await loadPopupState();

    const applyStateToDom = () => {
      companyInput.value = popupState.company || "";
      jdInput.value = popupState.jd || "";
      promptInput.value = popupState.prompt || "";

      const validCategory = DB.categories.some((cat) => cat.id === popupState.categoryId);
      if (validCategory) {
        categorySelect.value = popupState.categoryId;
        populateProjects(popupState.categoryId);
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
    };

    applyStateToDom();
    hydratePdfLink(pdfLink);

    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        window.close();
      });
    }

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
    handleInput(jdInput, "jd");
    handleInput(promptInput, "prompt");

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

    generateBtn.addEventListener("click", async () => {
      const company = companyInput.value.trim();
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

  });
})();
