document.addEventListener("DOMContentLoaded", () => {
  const $ = id => document.getElementById(id);

  const GOOGLE_KEY_UI = {
    input: "googleKeyInput",
    list: "googleKeyList",
    add: "addGoogleKey",
  };
  const GROQ_KEY_UI = {
    input: "groqKeyInput",
    list: "groqKeyList",
    add: "addGroqKey",
  };

  const ensureModelDefaults = (raw) => {
    const base = {
      apikey: "",
      groqApiKey: "",
      location: "",
      categories: [],
      projects: [],
      modelKeys: { google: [], groq: [] },
      modelKeyIndex: { google: 0, groq: 0 },
      modelKeySelection: { google: "", groq: "" },
    };
    const merged = { ...base, ...(raw || {}) };
    merged.categories = Array.isArray(merged.categories) ? merged.categories : [];
    merged.projects = Array.isArray(merged.projects) ? merged.projects : [];
    merged.modelKeys = merged.modelKeys || {};
    if (!Array.isArray(merged.modelKeys.google)) merged.modelKeys.google = [];
    if (!Array.isArray(merged.modelKeys.groq)) merged.modelKeys.groq = [];
    // Migrate legacy string keys -> objects with id/name/key
    merged.modelKeys.google = merged.modelKeys.google
      .map((entry, idx) => {
        if (entry && typeof entry === "object" && entry.key) {
          return {
            id: entry.id || `gk-${Date.now()}-${idx}`,
            name: entry.name || `Key ${idx + 1}`,
            key: String(entry.key),
            tier: entry.tier || "unpaid",
          };
        }
        if (typeof entry === "string") {
          return {
            id: `gk-${Date.now()}-${idx}`,
            name: `Key ${idx + 1}`,
            key: entry,
            tier: "unpaid",
          };
        }
        return null;
      })
      .filter(Boolean);
    merged.modelKeys.groq = merged.modelKeys.groq
      .map((entry, idx) => {
        if (entry && typeof entry === "object" && entry.key) {
          return {
            id: entry.id || `gq-${Date.now()}-${idx}`,
            name: entry.name || `Key ${idx + 1}`,
            key: String(entry.key),
            tier: entry.tier || "unpaid",
          };
        }
        if (typeof entry === "string") {
          return {
            id: `gq-${Date.now()}-${idx}`,
            name: `Key ${idx + 1}`,
            key: entry,
            tier: "unpaid",
          };
        }
        return null;
      })
      .filter(Boolean);
    merged.modelKeyIndex = merged.modelKeyIndex || { google: 0, groq: 0 };
    merged.modelKeySelection = merged.modelKeySelection || { google: "", groq: "" };
    if (merged.apikey && merged.modelKeys.google.length === 0) {
      merged.modelKeys.google = [
        { id: `gk-${Date.now()}-0`, name: "Primary", key: merged.apikey, tier: "unpaid" },
      ];
    }
    if (!merged.apikey && merged.modelKeys.google.length > 0) {
      merged.apikey = merged.modelKeys.google[0].key;
    }
    if (!merged.modelKeySelection.google && merged.modelKeys.google.length > 0) {
      merged.modelKeySelection.google = merged.modelKeys.google[0].id;
    }
    if (merged.groqApiKey && merged.modelKeys.groq.length === 0) {
      merged.modelKeys.groq = [
        { id: `gq-${Date.now()}-0`, name: "Primary", key: merged.groqApiKey, tier: "unpaid" },
      ];
    }
    if (!merged.groqApiKey && merged.modelKeys.groq.length > 0) {
      merged.groqApiKey = merged.modelKeys.groq[0].key;
    }
    if (!merged.modelKeySelection.groq && merged.modelKeys.groq.length > 0) {
      merged.modelKeySelection.groq = merged.modelKeys.groq[0].id;
    }
    // Legacy migrations
    if (!merged.groqApiKey && merged.modelKeys["groq-llama"]?.length) {
      merged.groqApiKey = merged.modelKeys["groq-llama"][0];
    }
    if (!merged.groqApiKey && merged.modelKeys["groq-oss120"]?.length) {
      merged.groqApiKey = merged.modelKeys["groq-oss120"][0];
    }
    return merged;
  };

  // --- State & Storage ---
  let DB = ensureModelDefaults();

  const storage = {
    get: () =>
      new Promise(res =>
        chrome.storage.local.get("resumeData", v => res(ensureModelDefaults(v.resumeData)))
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
    up.textContent = "Up";

    const down = document.createElement("button");
    down.type = "button";
    down.className = "small move-down";
    down.textContent = "Down";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "small danger remove-bullet";
    del.textContent = "Remove";

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

  // --- Model key helpers ---
  const maskKey = (key) => {
    const tail = String(key || "").slice(-4);
    return tail ? `****${tail}` : "****";
  };

  const renderGoogleKeyList = () => {
    const listEl = $(GOOGLE_KEY_UI.list);
    if (!listEl) return;
    const keys = DB.modelKeys?.google || [];
    listEl.innerHTML = "";
    if (!keys.length) {
      listEl.innerHTML = `<p class="muted">No keys saved.</p>`;
      return;
    }
    keys.forEach((entry, idx) => {
      const item = document.createElement("div");
      item.className = "key-item";
      const isSelected = DB.modelKeySelection?.google === entry.id;
      const tier = entry.tier === "paid" ? "Paid" : "Unpaid";
      item.innerHTML = `
        <div class="key-meta">
          <label>
            <input type="radio" name="googleKeySelect" data-id="${entry.id}" ${isSelected ? "checked" : ""}>
            Use
          </label>
          <span>${entry.name || `Key ${idx + 1}`}</span>
          <span>${tier}</span>
          <span>${maskKey(entry.key)}</span>
        </div>
        <div class="key-actions">
          <button class="small ghost" data-provider="google" data-action="edit" data-id="${entry.id}">Edit</button>
          <button class="small danger" data-provider="google" data-action="remove" data-id="${entry.id}">Remove</button>
        </div>
      `;
      listEl.appendChild(item);
    });
  };

  const renderGroqKeyList = () => {
    const listEl = $(GROQ_KEY_UI.list);
    if (!listEl) return;
    const keys = DB.modelKeys?.groq || [];
    listEl.innerHTML = "";
    if (!keys.length) {
      listEl.innerHTML = `<p class="muted">No keys saved.</p>`;
      return;
    }
    keys.forEach((entry, idx) => {
      const item = document.createElement("div");
      item.className = "key-item";
      const isSelected = DB.modelKeySelection?.groq === entry.id;
      const tier = entry.tier === "paid" ? "Paid" : "Unpaid";
      item.innerHTML = `
        <div class="key-meta">
          <label>
            <input type="radio" name="groqKeySelect" data-id="${entry.id}" ${isSelected ? "checked" : ""}>
            Use
          </label>
          <span>${entry.name || `Key ${idx + 1}`}</span>
          <span>${tier}</span>
          <span>${maskKey(entry.key)}</span>
        </div>
        <div class="key-actions">
          <button class="small ghost" data-provider="groq" data-action="edit" data-id="${entry.id}">Edit</button>
          <button class="small danger" data-provider="groq" data-action="remove" data-id="${entry.id}">Remove</button>
        </div>
      `;
      listEl.appendChild(item);
    });
  };

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
      const clsName = cat?.clsFileName || (clsContent ? "fed-res.cls" : "");
      $("categoryClsContent").value = clsContent;
      $("categoryClsFilename").value = clsName;
      if (clsContent) {
        const label = clsName || "fed-res.cls";
        $("clsFileStatus").textContent = `${label} is already saved.`;
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
    // Model provider & settings
    $("saveSettings").addEventListener("click", async () => {
      DB.location = $("defaultLocation").value.trim();
      await storage.set(DB);
      const stateEl = $("settingsState");
      if (stateEl) {
        stateEl.textContent = "Saved";
        setTimeout(() => { stateEl.textContent = ""; }, 2000);
      }
    });

    // Google API key management (multi-key)
    (() => {
      const btn = $(GOOGLE_KEY_UI.add);
      const input = $(GOOGLE_KEY_UI.input);
      const nameInput = $("googleKeyNameInput");
      const tierInput = $("googleKeyTier");
      let editId = "";
      if (btn && input) {
        btn.addEventListener("click", async () => {
          const key = input.value.trim();
          const rawName = (nameInput?.value || "").trim();
          const tier = (tierInput?.value || "unpaid").trim();
          if (!key && !editId) return;

          if (editId) {
            const idx = (DB.modelKeys.google || []).findIndex((k) => k.id === editId);
            if (idx > -1) {
              const existing = DB.modelKeys.google[idx];
              DB.modelKeys.google[idx] = {
                ...existing,
                name: rawName || existing.name,
                key: key || existing.key,
                tier: tier || existing.tier || "unpaid",
              };
              if (DB.modelKeySelection?.google === editId) {
                DB.apikey = DB.modelKeys.google[idx].key;
              }
            }
            editId = "";
            btn.textContent = "Add Key";
          } else {
            const name = rawName || `Key ${DB.modelKeys.google.length + 1}`;
            const id = `gk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            DB.modelKeys.google = [
              ...(DB.modelKeys.google || []),
              { id, name, key, tier },
            ];
            if (!DB.apikey) DB.apikey = key;
            if (!DB.modelKeySelection?.google) {
              DB.modelKeySelection = { ...(DB.modelKeySelection || {}), google: id };
            }
          }
          input.value = "";
          if (nameInput) nameInput.value = "";
          if (tierInput) tierInput.value = "unpaid";
          await storage.set(DB);
          renderGoogleKeyList();
        });
      }

      const listEl = $(GOOGLE_KEY_UI.list);
      if (listEl) {
        listEl.addEventListener("click", async (e) => {
          const radio = e.target.closest("input[type='radio'][name='googleKeySelect']");
          if (radio) {
            const id = radio.dataset.id;
            DB.modelKeySelection = { ...(DB.modelKeySelection || {}), google: id };
            const selected = (DB.modelKeys.google || []).find((k) => k.id === id);
            if (selected?.key) DB.apikey = selected.key;
            await storage.set(DB);
            renderGoogleKeyList();
            return;
          }
          const actionBtn = e.target.closest("button[data-action][data-id]");
          if (!actionBtn) return;
          const action = actionBtn.dataset.action;
          const id = actionBtn.dataset.id;
          if (action === "edit") {
            const entry = (DB.modelKeys.google || []).find((k) => k.id === id);
            if (!entry) return;
            editId = id;
            input.value = "";
            if (nameInput) nameInput.value = entry.name || "";
            if (tierInput) tierInput.value = entry.tier || "unpaid";
            input.focus();
            btn.textContent = "Update Key";
            return;
          }
          if (action === "remove") {
            const removed = (DB.modelKeys.google || []).find((k) => k.id === id);
            DB.modelKeys.google = (DB.modelKeys.google || []).filter((k) => k.id !== id);
            if (removed?.id && DB.modelKeySelection?.google === removed.id) {
              const next = DB.modelKeys.google[0];
              DB.modelKeySelection = { ...(DB.modelKeySelection || {}), google: next?.id || "" };
              DB.apikey = next?.key || "";
            }
            if (!DB.apikey && DB.modelKeys.google[0]?.key) {
              DB.apikey = DB.modelKeys.google[0].key;
            }
            await storage.set(DB);
            renderGoogleKeyList();
          }
        });
      }
    })();

    // Groq API key management (multi-key)
    (() => {
      const btn = $(GROQ_KEY_UI.add);
      const input = $(GROQ_KEY_UI.input);
      const nameInput = $("groqKeyNameInput");
      const tierInput = $("groqKeyTier");
      let editId = "";
      if (btn && input) {
        btn.addEventListener("click", async () => {
          const key = input.value.trim();
          const rawName = (nameInput?.value || "").trim();
          const tier = (tierInput?.value || "unpaid").trim();
          if (!key && !editId) return;

          if (editId) {
            const idx = (DB.modelKeys.groq || []).findIndex((k) => k.id === editId);
            if (idx > -1) {
              const existing = DB.modelKeys.groq[idx];
              DB.modelKeys.groq[idx] = {
                ...existing,
                name: rawName || existing.name,
                key: key || existing.key,
                tier: tier || existing.tier || "unpaid",
              };
              if (DB.modelKeySelection?.groq === editId) {
                DB.groqApiKey = DB.modelKeys.groq[idx].key;
              }
            }
            editId = "";
            btn.textContent = "Add Key";
          } else {
            const name = rawName || `Key ${DB.modelKeys.groq.length + 1}`;
            const id = `gq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            DB.modelKeys.groq = [
              ...(DB.modelKeys.groq || []),
              { id, name, key, tier },
            ];
            if (!DB.groqApiKey) DB.groqApiKey = key;
            if (!DB.modelKeySelection?.groq) {
              DB.modelKeySelection = { ...(DB.modelKeySelection || {}), groq: id };
            }
          }
          input.value = "";
          if (nameInput) nameInput.value = "";
          if (tierInput) tierInput.value = "unpaid";
          await storage.set(DB);
          renderGroqKeyList();
        });
      }

      const listEl = $(GROQ_KEY_UI.list);
      if (listEl) {
        listEl.addEventListener("click", async (e) => {
          const radio = e.target.closest("input[type='radio'][name='groqKeySelect']");
          if (radio) {
            const id = radio.dataset.id;
            DB.modelKeySelection = { ...(DB.modelKeySelection || {}), groq: id };
            const selected = (DB.modelKeys.groq || []).find((k) => k.id === id);
            if (selected?.key) DB.groqApiKey = selected.key;
            await storage.set(DB);
            renderGroqKeyList();
            return;
          }
          const actionBtn = e.target.closest("button[data-action][data-id]");
          if (!actionBtn) return;
          const action = actionBtn.dataset.action;
          const id = actionBtn.dataset.id;
          if (action === "edit") {
            const entry = (DB.modelKeys.groq || []).find((k) => k.id === id);
            if (!entry) return;
            editId = id;
            input.value = "";
            if (nameInput) nameInput.value = entry.name || "";
            if (tierInput) tierInput.value = entry.tier || "unpaid";
            input.focus();
            btn.textContent = "Update Key";
            return;
          }
          if (action === "remove") {
            const removed = (DB.modelKeys.groq || []).find((k) => k.id === id);
            DB.modelKeys.groq = (DB.modelKeys.groq || []).filter((k) => k.id !== id);
            if (removed?.id && DB.modelKeySelection?.groq === removed.id) {
              const next = DB.modelKeys.groq[0];
              DB.modelKeySelection = { ...(DB.modelKeySelection || {}), groq: next?.id || "" };
              DB.groqApiKey = next?.key || "";
            }
            if (!DB.groqApiKey && DB.modelKeys.groq[0]?.key) {
              DB.groqApiKey = DB.modelKeys.groq[0].key;
            }
            await storage.set(DB);
            renderGroqKeyList();
          }
        });
      }
    })();

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
      $("categoryClsFilename").value = file.name;
      $("uploadClsBtn").textContent = "Replace .cls File";
      $("clsFileStatus").textContent = `${file.name} ready to be saved.`;
    });

    // Category CRUD
    $("saveCategoryBtn").addEventListener("click", async () => {
      const id = $("categoryId").value || `cat-${Date.now()}`;
      const clsContent = $("categoryClsContent").value.trim();
      const clsNameInput = $("categoryClsFilename").value.trim();
      const clsFileName = clsContent ? (clsNameInput || "fed-res.cls") : "";
      const newCat = {
        id,
        name: $("categoryName").value.trim(),
        keywords: $("categoryKeywords").value.split(',').map(k => k.trim()).filter(Boolean),
        latex: $("categoryLatex").value.trim(),
        clsFileContent: clsContent,
        clsFileName,
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
    DB = ensureModelDefaults(await storage.get());
    $("defaultLocation").value = DB.location || "";
    renderGoogleKeyList();
    renderGroqKeyList();
    renderAll();
  };

  setupEventListeners();
  load();
});
