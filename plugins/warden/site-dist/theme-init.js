(function () {
  var d = document.documentElement, t = null;
  try { t = localStorage.getItem("warden-theme"); } catch (e) {}
  if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  d.setAttribute("data-theme", t);
})();
