// options.js — stores LaTeX locally; small keys (keywords, apikey, engine) in sync
document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);

  // Promise helpers
  const syncGet    = (keys) => new Promise(res => chrome.storage.sync.get(keys, v => res(v || {})));
  const syncSet    = (obj)  => new Promise(res => chrome.storage.sync.set(obj, () => res()));
  const syncRemove = (key)  => new Promise(res => chrome.storage.sync.remove(key, () => res()));
  const localGet   = (keys) => new Promise(res => chrome.storage.local.get(keys, v => res(v || {})));
  const localSet   = (obj)  => new Promise(res => chrome.storage.local.set(obj, () => res()));

  // ---------- Load ----------
// ---------- Load ----------
async function load() {
  try {
    const [{ latex: syncLatex = "" }, { latex: localLatex = "" }] = await Promise.all([
      syncGet(["latex"]),
      localGet(["latex"])
    ]);
    let latex = localLatex || syncLatex || "";
    if (!localLatex && syncLatex) {
      await localSet({ latex: syncLatex });
      await syncRemove("latex");
    }

    const { keywords = [], apikey = "", engine = "pdflatex" } =
      await syncGet(["keywords", "apikey", "engine"]);

    // ✅ write with guards (no optional chaining on LHS)
    const latexEl = $("latex");
    if (latexEl) latexEl.value = latex;

    const keywordsEl = $("keywords");
    if (keywordsEl) keywordsEl.value = Array.isArray(keywords) ? keywords.join(", ") : (keywords || "");

    const apikeyEl = $("apikey");
    if (apikeyEl) apikeyEl.value = apikey || "";

    const engineEl = $("engine");
    if (engineEl) engineEl.value = engine || "pdflatex";

    renderAssets();
  } catch (e) {
    console.error("Load error:", e);
  }
}


  // ---------- Import/Export ----------
  $("loadFile")?.addEventListener("click", async () => {
    const fileInput = $("texfile");
    if (!fileInput?.files?.length) return alert("Choose a .tex file first.");
    const text = await fileInput.files[0].text();
    $("latex").value = text;
  });

  $("save")?.addEventListener("click", async () => {
    const latex    = $("latex")?.value ?? "";
    const keywords = ($("keywords")?.value || "").split(",").map(s => s.trim()).filter(Boolean);
    const apikey   = ($("apikey")?.value || "").trim();
    const engine   = $("engine") ? $("engine").value : "pdflatex";

    await Promise.all([
      localSet({ latex }),
      syncSet({ keywords, apikey, engine })
    ]);

    if ($("saveState")) {
      $("saveState").textContent = "Saved ✓ (LaTeX stored locally)";
      setTimeout(() => $("saveState").textContent = "", 1800);
    }
  });

  $("export")?.addEventListener("click", async () => {
    const [syncData, localData] = await Promise.all([
      syncGet(["keywords", "apikey", "engine"]),
      localGet(["latex", "assets"])
    ]);
    const data = { ...localData, ...syncData };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "ats-enhancer-settings.json";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });

  $("importBtn")?.addEventListener("click", async () => {
    const input = $("importFile");
    if (!input?.files?.length) return alert("Choose a JSON file exported from this tool.");
    try {
      const obj = JSON.parse(await input.files[0].text());
      await Promise.all([
        localSet({ latex: obj.latex || "", assets: Array.isArray(obj.assets) ? obj.assets : undefined }),
        syncSet({
          keywords: Array.isArray(obj.keywords) ? obj.keywords :
                    (obj.keywords ? String(obj.keywords).split(",").map(s=>s.trim()).filter(Boolean) : []),
          apikey: obj.apikey || "",
          engine: obj.engine || "pdflatex"
        })
      ]);
      await load();
      if ($("saveState")) {
        $("saveState").textContent = "Imported ✓";
        setTimeout(() => $("saveState").textContent = "", 1800);
      }
    } catch (e) {
      console.error(e); alert("Invalid JSON");
    }
  });

  // ---------- Supporting files (assets) ----------
  function bytesToSize(n) {
    if (!n) return "0 B";
    const u = ["B","KB","MB","GB"]; const i = Math.floor(Math.log(n)/Math.log(1024));
    return (n/Math.pow(1024,i)).toFixed(1) + " " + u[i];
  }

  async function renderAssets() {
    const { assets = [] } = await localGet(["assets"]);
    const list = document.getElementById("assetList");
    const state = document.getElementById("assetState");
    if (!list || !state) return;

    list.innerHTML = "";
    let total = 0;
    assets.forEach((a, idx) => {
      total += (a.size || Math.ceil((a.dataBase64?.length || a.data?.length || 0) * 0.75));
      const li = document.createElement("li");
      li.style.margin = "6px 0";
      li.style.display = "flex";
      li.style.justifyContent = "space-between";
      li.style.alignItems = "center";
      li.innerHTML = `
        <span style="font-size:13px;color:#cfe6f8">${a.name}</span>
        <span style="font-size:12px;color:#8fb8d7">${bytesToSize(total)}</span>
        <button data-idx="${idx}" class="ghost" style="margin-left:8px;">Remove</button>
      `;
      list.appendChild(li);
    });
    state.textContent = assets.length
      ? `Stored ${assets.length} files (${bytesToSize(total)}).`
      : "No supporting files added yet.";

    // bind remove
    list.querySelectorAll("button[data-idx]")?.forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const idx = Number(e.currentTarget.getAttribute("data-idx"));
        const { assets = [] } = await localGet(["assets"]);
        assets.splice(idx, 1);
        await localSet({ assets });
        renderAssets();
      });
    });
  }

  async function addSelectedAssets() {
    const input = document.getElementById("assetPicker");
    if (!input?.files?.length) return alert("Choose one or more files first.");
    const files = Array.from(input.files);

    // read as base64; store both .data and .dataBase64 for compatibility
    const reads = files.map(f => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const dataUrl = String(r.result);
        const base64 = dataUrl.substring(dataUrl.indexOf(",")+1);
        resolve({
          name: f.name,
          type: f.type || "application/octet-stream",
          mime: f.type || "application/octet-stream",
          size: f.size,
          data: base64,
          dataBase64: base64
        });
      };
      r.onerror = reject;
      r.readAsDataURL(f);
    }));

    const picked = await Promise.all(reads);
    const store = await localGet(["assets"]);
    const cur = Array.isArray(store.assets) ? store.assets : [];
    const nameMap = new Map(cur.map(a => [a.name, a]));
    picked.forEach(p => nameMap.set(p.name, p));
    const merged = Array.from(nameMap.values());

    // soft cap ~15MB to avoid local quota surprises
    const approxBytes = merged.reduce((s,a)=> s + (a.size || Math.ceil((a.dataBase64?.length || a.data?.length || 0)*0.75)), 0);
    if (approxBytes > 15*1024*1024) {
      alert("Total supporting files exceed ~15 MB. Remove some large assets.");
      return;
    }

    await localSet({ assets: merged });
    input.value = "";
    renderAssets();
  }

  async function clearAllAssets() {
    if (!confirm("Remove ALL supporting files?")) return;
    await localSet({ assets: [] });
    renderAssets();
  }

  document.getElementById("addAssets")?.addEventListener("click", addSelectedAssets);
  document.getElementById("clearAssets")?.addEventListener("click", clearAllAssets);

  // ---------- Go ----------
  load();
});
