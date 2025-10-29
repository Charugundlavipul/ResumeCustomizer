// Injected overlay for resume enhancer status
(() => {
  const POPUP_STATE_KEY = "popupState";
  const OVERLAY_ID = "ats-resume-overlay";
  const STYLE_ID = "ats-resume-overlay-style";

  if (document.getElementById(OVERLAY_ID)) {
    chrome.storage.local.get(POPUP_STATE_KEY).then((res) => {
      const state = res?.[POPUP_STATE_KEY] || {};
      window.dispatchEvent(new CustomEvent("ats-mini-sync", { detail: state }));
    });
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      left: 16px;
      bottom: 20px;
      z-index: 2147483647;
      font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #eaf6ff;
    }
    #${OVERLAY_ID} .mini {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      background: #13273b;
      border: 1px solid rgba(255,255,255,0.14);
      box-shadow: 0 8px 22px rgba(0,0,0,0.35);
    }
    #${OVERLAY_ID} .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #2eaadc;
      flex: 0 0 auto;
    }
    #${OVERLAY_ID} .text {
      font-size: 12px;
      color: #a7c2d9;
      max-width: 240px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${OVERLAY_ID} a.download {
      display: none;
      padding: 6px 12px;
      border-radius: 10px;
      background: #0f2235;
      color: #eaf6ff;
      text-decoration: none;
      border: 1px solid rgba(255,255,255,0.18);
      font-size: 12px;
    }
    #${OVERLAY_ID} button.toggle {
      border: none;
      background: transparent;
      color: #a7c2d9;
      font-size: 12px;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 8px;
    }
    #${OVERLAY_ID} button.toggle:hover {
      background: rgba(255,255,255,0.12);
    }
    #${OVERLAY_ID}[data-collapsed="1"] .text,
    #${OVERLAY_ID}[data-collapsed="1"] .actions {
      display: none;
    }
  `;
  document.documentElement.appendChild(style);

  const wrapper = document.createElement("div");
  wrapper.id = OVERLAY_ID;
  wrapper.innerHTML = `
    <div class="mini">
      <div class="dot"></div>
      <div class="text" id="ats-mini-text">Preparing...</div>
      <div class="actions">
        <a id="ats-mini-download" class="download" download>Download</a>
      </div>
      <button id="ats-mini-collapse" class="toggle" title="Collapse">–</button>
    </div>
  `;
  document.documentElement.appendChild(wrapper);

  const textEl = wrapper.querySelector("#ats-mini-text");
  const downloadEl = wrapper.querySelector("#ats-mini-download");
  const collapseBtn = wrapper.querySelector("#ats-mini-collapse");
  let currentBlob = "";

  const revokeBlob = () => {
    if (currentBlob && currentBlob.startsWith("blob:")) {
      URL.revokeObjectURL(currentBlob);
    }
    currentBlob = "";
  };

  const syncState = (state = {}) => {
    const { status, pdfB64, pdfFilename, generationInBackground } = state;
    if (textEl) {
      textEl.textContent = status || (generationInBackground ? "Working..." : "Idle");
    }

    revokeBlob();
    if (pdfB64) {
      try {
        const bytes = Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0));
        currentBlob = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
        downloadEl.href = currentBlob;
        downloadEl.download = pdfFilename || "Vipul_Charugundla_generated.pdf";
        downloadEl.style.display = "inline-flex";
      } catch (err) {
        console.warn("Overlay download hydrate failed", err);
        downloadEl.removeAttribute("href");
        downloadEl.style.display = "none";
      }
    } else {
      downloadEl.removeAttribute("href");
      downloadEl.style.display = "none";
    }
  };

  downloadEl?.addEventListener("click", (ev) => {
    if (!downloadEl.href) return;
    ev.preventDefault();
    const names = [
      downloadEl.download || "Vipul_Charugundla_generated.pdf",
      "Vipul_Charugundla.pdf"
    ];
    names.forEach((name) => {
      const a = document.createElement("a");
      a.href = downloadEl.href;
      a.download = name;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  });

  collapseBtn?.addEventListener("click", () => {
    const collapsed = wrapper.getAttribute("data-collapsed") === "1";
    wrapper.setAttribute("data-collapsed", collapsed ? "0" : "1");
    collapseBtn.textContent = collapsed ? "–" : "+";
    collapseBtn.title = collapsed ? "Collapse" : "Expand";
  });

  chrome.storage.local.get(POPUP_STATE_KEY).then((res) => syncState(res?.[POPUP_STATE_KEY] || {}));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes?.[POPUP_STATE_KEY]) return;
    syncState(changes[POPUP_STATE_KEY].newValue || {});
  });

  window.addEventListener("ats-mini-sync", (event) => syncState(event.detail || {}));
  window.addEventListener("unload", revokeBlob);
})();
