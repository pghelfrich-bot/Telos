// Client router. The worker serves index.html for every non-asset path (the
// single-page-application fallback), so this script decides which view to
// render from the URL: /c/:slug is the student guide, everything else is the
// instructor console.
(function () {
  "use strict";
  function boot() {
    var root = document.getElementById("app");
    if (!root) return;
    var match = location.pathname.match(/^\/c\/([^\/]+)\/?$/);
    if (match) {
      SG.renderStudent(root, decodeURIComponent(match[1]));
    } else if (SG.renderAdmin) {
      SG.renderAdmin(root);
    } else {
      root.appendChild(SG.el("p", { text: "Instructor console" }));
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
