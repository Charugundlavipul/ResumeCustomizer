 ATS-Optimized Resume Enhancer (Pipeline, MV3) — Fixed Build

This build fixes the Options page **load bug** (IDs were referenced with `#`), so your saved settings persist and repopulate after refresh. Also adds **Export/Import** for your settings.

### What it does
- Light ATS-safe edits across your resume based on a JD (no hidden text).
- Rewrites up to **2 bullets** total + optional **1 added bullet** for regression testing/UAT/CI-CD.
- Up to **5 skill substitutions** across skills lines; counts preserved.

### Why your settings “disappeared”
- In the previous build, the Options page tried `document.getElementById("#latex")` (with `#`), which returns `null`, so fields looked empty after reload even though values were saved. This is now fixed.

### Tips
- Don’t change the folder path of the unpacked extension; doing so generates a new extension ID and storage. Use Export/Import if you move it.
