document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

  // --- State & Storage ---
  let DB = { apikey: "", categories: [], projects: [] };

  const storage = {
    get: () =>
      new Promise(res =>
        chrome.storage.local.get("resumeData", v => res(v.resumeData || DB))
      ),
    set: (data) =>
      new Promise(res => chrome.storage.local.set({ resumeData: data }, res)),
  };

  // ───────────────────────── Bullets UI helpers ─────────────────────────
  function ensureAtLeastOneBulletRow() {
    const list = $("projectBulletsList");
    if (!list) return;
    if (!list.querySelector(".row")) appendBulletRow("");
  }

  function renderBulletList(bullets = []) {
    const list = $("projectBulletsList");
    if (!list) return; // fallback mode (old textarea)
    list.innerHTML = "";
    if (!bullets || bullets.length === 0) bullets = [""];
    bullets.forEach(val => appendBulletRow(val));
  }

  function appendBulletRow(value = "") {
    const list = $("projectBulletsList");
    if (!list) return;

    const row = document.createElement("div");
    row.className = "row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "bullet-input";
    input.placeholder = "e.g., Built an AI-powered therapy platform…";
    input.value = value || "";

    const up = document.createElement("button");
    up.type = "button";
    up.className = "small move-up";
    up.textContent = "↑";

    const down = document.createElement("button");
    down.type = "button";
    down.className = "small move-down";
    down.textContent = "↓";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "small danger remove-bullet";
    del.textContent = "✕";

    row.appendChild(input);
    row.appendChild(up);
    row.appendChild(down);
    row.appendChild(del);
    list.appendChild(row);
  }

  function collectBulletsFromUI() {
    const list = $("projectBulletsList");
    if (!list) {
      // Fallback to legacy textarea if list not present in HTML yet
      const ta = $("projectBullets");
      return (ta?.value || "")
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean);
    }
    return Array.from(list.querySelectorAll(".bullet-input"))
      .map(i => i.value.trim())
      .filter(Boolean);
  }

  // --- UI Rendering ---
  const renderCategories = () => {
    const listEl = $("categoryList");
    listEl.innerHTML = "";
    if (!DB.categories.length) {
      listEl.innerHTML = `<p class="muted" style="margin-bottom:10px;">No categories created yet.</p>`;
      return;
    }
    DB.categories.forEach(cat => {
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <span>${cat.name}</span>
        <div>
          <button data-id="${cat.id}" class="edit-cat ghost">Edit</button>
          <button data-id="${cat.id}" class="delete-cat danger">Delete</button>
        </div>
      `;
      listEl.appendChild(item);
    });
  };

  const renderProjects = () => {
    const listEl = $("projectList");
    listEl.innerHTML = "";
    if (!DB.projects.length) {
      listEl.innerHTML = `<p class="muted" style="margin-bottom:10px;">No projects created yet.</p>`;
      return;
    }
    DB.projects.forEach(proj => {
      const item = document.createElement("div");
      item.className = "list-item";
      item.innerHTML = `
        <span>${proj.name}</span>
        <div>
          <button data-id="${proj.id}" class="edit-proj ghost">Edit</button>
          <button data-id="${proj.id}" class="delete-proj danger">Delete</button>
        </div>
      `;
      listEl.appendChild(item);
    });
  };

  const renderAll = () => {
    renderCategories();
    renderProjects();
  };

  // --- Modals ---
  const categoryModal = {
    el: $("categoryModal"),
    show: (cat = null) => {
      $("categoryModalTitle").textContent = cat ? "Edit Category" : "Create Category";
      $("categoryId").value = cat?.id || "";
      $("categoryName").value = cat?.name || "";
      $("categoryKeywords").value = Array.isArray(cat?.keywords) ? cat.keywords.join(", ") : (cat?.keywords || "");
      $("categoryLatex").value = cat?.latex || "";

      // .cls file handling
      const clsContent = cat?.clsFileContent || "";
      $("categoryClsContent").value = clsContent;
      if (clsContent) {
        $("clsFileStatus").textContent = "fed-res.cls is already saved.";
        $("uploadClsBtn").textContent = "Replace .cls File";
      } else {
        $("clsFileStatus").textContent = "No .cls file uploaded.";
        $("uploadClsBtn").textContent = "Upload .cls File";
      }
      $("categoryClsFile").value = ""; // Clear file input

      categoryModal.el.style.display = "block";
    },
    hide: () => { categoryModal.el.style.display = "none"; }
  };

  const projectModal = {
    el: $("projectModal"),
    show: (proj = null) => {
      $("projectModalTitle").textContent = proj ? "Edit Project" : "Create Project";
      $("projectId").value = proj?.id || "";
      $("projectName").value = proj?.name || "";
      $("projectDates").value = proj?.dates || "";
      $("projectLink").value = proj?.link || "";

      // NEW: bullets list UI (fallback to textarea if list not present yet)
      if ($("projectBulletsList")) {
        renderBulletList(proj?.bullets || []);
        ensureAtLeastOneBulletRow();
      } else if ($("projectBullets")) {
        $("projectBullets").value = (proj?.bullets || []).join("\n");
      }

      const assocEl = $("projectCategoryAssociation");
      assocEl.innerHTML = "";
      DB.categories.forEach(cat => {
        const isChecked = proj?.categoryIds?.includes(cat.id);
        assocEl.innerHTML += `
          <label style="display:inline-block; margin-right:15px;">
            <input type="checkbox" value="${cat.id}" ${isChecked ? "checked" : ""}>
            ${cat.name}
          </label>
        `;
      });
      projectModal.el.style.display = "block";
    },
    hide: () => { projectModal.el.style.display = "none"; }
  };

  // --- Event Handlers ---
  const setupEventListeners = () => {
    // API Key & Settings
    $("saveApiKey").addEventListener("click", async () => {
      DB.apikey = $("apikey").value.trim();
      await storage.set(DB);
      // robust to minor id typos in HTML
      const stateEl = $("apikeyState") || $("apikeytate") || $("apikeyStatus");
      if (stateEl) {
        stateEl.textContent = "Saved ✓";
        setTimeout(() => { stateEl.textContent = ""; }, 2000);
      }
    });

    // Modals
    $("showCategoryModalBtn").addEventListener("click", () => categoryModal.show());
    $("closeCategoryModalBtn").addEventListener("click", categoryModal.hide);
    $("showProjectModalBtn").addEventListener("click", () => projectModal.show());
    $("closeProjectModalBtn").addEventListener("click", projectModal.hide);

    // .cls file upload
    $("uploadClsBtn").addEventListener("click", () => $("categoryClsFile").click());
    $("categoryClsFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      $("categoryClsContent").value = text;
      $("clsFileStatus").textContent = `${file.name} ready to be saved.`;
    });

    // Category CRUD
    $("saveCategoryBtn").addEventListener("click", async () => {
      const id = $("categoryId").value || `cat-${Date.now()}`;
      const newCat = {
        id,
        name: $("categoryName").value.trim(),
        keywords: $("categoryKeywords").value.split(',').map(k => k.trim()).filter(Boolean),
        latex: $("categoryLatex").value.trim(),
        clsFileContent: $("categoryClsContent").value.trim(),
      };
      const index = DB.categories.findIndex(c => c.id === id);
      if (index > -1) {
        DB.categories[index] = newCat;
      } else {
        DB.categories.push(newCat);
      }
      await storage.set(DB);
      renderAll();
      categoryModal.hide();
    });

    $("categoryList").addEventListener("click", async (e) => {
      const target = e.target;
      const id = target.dataset.id;
      if (!id) return;

      if (target.classList.contains("edit-cat")) {
        const cat = DB.categories.find(c => c.id === id);
        categoryModal.show(cat);
      } else if (target.classList.contains("delete-cat")) {
        if (confirm("Are you sure you want to delete this category?")) {
          DB.categories = DB.categories.filter(c => c.id !== id);
          DB.projects.forEach(p => { p.categoryIds = p.categoryIds.filter(catId => catId !== id); });
          await storage.set(DB);
          renderAll();
        }
      }
    });

    // Project CRUD
    $("saveProjectBtn").addEventListener("click", async () => {
      const id = $("projectId").value || `proj-${Date.now()}`;
      const selectedCatIds = Array.from($("projectCategoryAssociation").querySelectorAll("input:checked")).map(el => el.value);
      const bullets = collectBulletsFromUI();

      const newProj = {
        id,
        name: $("projectName").value.trim(),
        dates: $("projectDates").value.trim(),
        link: $("projectLink").value.trim(),
        bullets, // ← array of points, exactly as entered
        categoryIds: selectedCatIds,
      };
      const index = DB.projects.findIndex(p => p.id === id);
      if (index > -1) {
        DB.projects[index] = newProj;
      } else {
        DB.projects.push(newProj);
      }
      await storage.set(DB);
      renderAll();
      projectModal.hide();
    });

    $("projectList").addEventListener("click", async (e) => {
      const target = e.target;
      const id = target.dataset.id;
      if (!id) return;

      if (target.classList.contains("edit-proj")) {
        const proj = DB.projects.find(p => p.id === id);
        projectModal.show(proj);
      } else if (target.classList.contains("delete-proj")) {
        if (confirm("Are you sure you want to delete this project?")) {
          DB.projects = DB.projects.filter(p => p.id !== id);
          await storage.set(DB);
          renderAll();
        }
      }
    });

    // Bullets UI: add / remove / move
    const listEl = $("projectBulletsList");
    const addBtn = $("addBulletBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        appendBulletRow("");
        const lastInput = Array.from(document.querySelectorAll("#projectBulletsList .bullet-input")).pop();
        if (lastInput) lastInput.focus();
      });
    }
    if (listEl) {
      listEl.addEventListener("click", (e) => {
        const row = e.target.closest(".row");
        if (!row) return;
        const list = $("projectBulletsList");

        if (e.target.classList.contains("remove-bullet")) {
          row.remove();
          ensureAtLeastOneBulletRow();
        } else if (e.target.classList.contains("move-up")) {
          const prev = row.previousElementSibling;
          if (prev) list.insertBefore(row, prev);
        } else if (e.target.classList.contains("move-down")) {
          const next = row.nextElementSibling;
          if (next) list.insertBefore(row, next.nextSibling); // move after next
        }
      });
    }

    // Import / Export
    $("export").addEventListener("click", async () => {
      const data = await storage.get();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "ats-enhancer-data.json"; a.click(); URL.revokeObjectURL(url);
    });

    $("importBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const content = await file.text();
        const data = JSON.parse(content);
        if (confirm("This will overwrite all current data. Continue?")) {
          await storage.set(data);
          await load();
        }
      } catch (err) {
        alert("Invalid JSON file.");
        console.error("Import error:", err);
      }
    });
  };

  // --- Initialization ---
  const load = async () => {
    DB = await storage.get();
    $("apikey").value = DB.apikey || "";
    renderAll();
  };

  setupEventListeners();
  load();
});
