// popup.js — PDF-only pipeline with “company” support & double-download
(() => {
  /* ---------- small helpers ---------- */
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else fn();
  }

  function hide(a) { a && (a.style.display = "none", a.removeAttribute("href")); }

  /* ---------- popup main ---------- */
  ready(() => {
    const $ = id => document.getElementById(id);

    /* ───── elements ───── */
    const openSettingsBtn = $("openSettings");
    const generateBtn     = $("generate");
    const jdEl            = $("jd");
    const promptEl        = $("prompt");
    const companyEl       = $("company");
    const statusEl        = $("status");
    const pdfLink         = $("downloadPdf");

    /* ───── hide Tex / Zip anchors (PDF-only build) ───── */
    hide($("downloadTex"));
    hide($("downloadZip"));

    openSettingsBtn?.addEventListener("click", () =>
      chrome.runtime.openOptionsPage()
    );

    /* ───── generate & compile ───── */
    generateBtn?.addEventListener("click", async () => {
      if (!jdEl || !statusEl || !companyEl) return;

      const jd       = jdEl.value.trim();
      const company  = companyEl.value.trim();
      const userPrompt = (promptEl?.value || "").trim();

      /* basic form validation */
      if (!jd)      { statusEl.textContent = "Please paste a Job Description."; jdEl.focus();      return; }
      if (!company) { statusEl.textContent = "Please enter a Company Name.";    companyEl.focus(); return; }

      /* revoke old blob URL & hide link */
      if (pdfLink?.href?.startsWith("blob:")) URL.revokeObjectURL(pdfLink.href);
      hide(pdfLink);

      /* UI feedback */
      const prevText = generateBtn.textContent;
      generateBtn.disabled   = true;
      generateBtn.textContent = "Working…";
      statusEl.textContent    = "Planning edits → rewriting → compiling…";

      try {
        const resp = await chrome.runtime.sendMessage({
          type:    "PROCESS_JD_PIPELINE",
          payload: { jd, prompt: userPrompt }
        });

        if (!resp || !resp.pdfB64) {
          statusEl.textContent = "Compile failed – see background console";
          return;
        }

        /* convert Base64 → Blob → object-URL */
        const bytes = Uint8Array.from(atob(resp.pdfB64), c => c.charCodeAt(0));
        const pdfUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));

        /* expose visible link for FIRST download */
        pdfLink.href        = pdfUrl;
        pdfLink.download    = "vipul_charugundla.pdf";
        pdfLink.style.display = "inline-block";
        statusEl.textContent = "✅  PDF ready. Click to download twice.";
      } catch (e) {
        console.error(e);
        statusEl.textContent = e?.message || "Unexpected error. See console.";
      } finally {
        generateBtn.disabled   = false;
        generateBtn.textContent = prevText;
      }
    });

    /* ───── double-download handler (runs on every click) ───── */
    pdfLink.addEventListener("click", () => {
      const company = companyEl?.value.trim();
      if (!company) return;   // should never happen (generate guard)

      /* fire the second, invisible download right after the first */
      setTimeout(() => {
        const clone = pdfLink.cloneNode(false);
        clone.href      = pdfLink.href;                 // same blob URL
        clone.download  = `vipul_${company}.pdf`;
        clone.style.display = "none";
        document.body.appendChild(clone);
        clone.click();                                  // triggers second save
        document.body.removeChild(clone);
      }, 0);
    });
  });
})();
