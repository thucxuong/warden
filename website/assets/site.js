// Warden website: theme toggle, docs menu, copy buttons, search, TOC highlight.
// Plain browser JavaScript, no dependencies.
(function () {
  "use strict";
  var doc = document.documentElement;
  var root = doc.getAttribute("data-root") || "";

  // Theme: follows the OS until the reader picks one; the pick is remembered.
  function effectiveTheme() {
    var t = doc.getAttribute("data-theme");
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  var themeBtn = document.querySelector(".theme-btn");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      doc.setAttribute("data-theme", next);
      try { localStorage.setItem("warden-theme", next); } catch (e) { /* storage blocked: still switches for this page */ }
    });
  }

  // Docs menu (narrow screens).
  var menuBtn = document.querySelector(".menu-btn");
  var scrim = document.querySelector(".scrim");
  var sb = document.getElementById("sidebar");
  function navOpen() { return document.body.classList.contains("nav-open"); }
  // focus: "in" moves focus into the menu, "button" back to the menu button.
  function setNav(open, focus) {
    document.body.classList.toggle("nav-open", open);
    if (menuBtn) {
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      menuBtn.setAttribute("aria-label", open ? "Close the docs menu" : "Open the docs menu");
    }
    if (scrim) scrim.hidden = !open;
    if (focus === "in" && sb) {
      var first = sb.querySelector('[aria-current="page"]') || sb.querySelector("a");
      if (first) first.focus();
    } else if (focus === "button" && menuBtn) {
      menuBtn.focus();
    }
  }
  if (menuBtn) {
    menuBtn.addEventListener("click", function () { var o = !navOpen(); setNav(o, o ? "in" : null); });
    if (scrim) scrim.addEventListener("click", function () { setNav(false, "button"); });
    if (sb) {
      // Close the menu when the keyboard leaves it (to anything but the menu button).
      sb.addEventListener("focusout", function (ev) {
        var to = ev.relatedTarget;
        if (navOpen() && to && !sb.contains(to) && to !== menuBtn) setNav(false);
      });
      var current = sb.querySelector('[aria-current="page"]');
      if (current) sb.scrollTop = Math.max(0, current.offsetTop - sb.clientHeight / 2);
    }
  }

  // Skip link: move focus to the main content. Done in script because the 404
  // page has a <base>, which would turn "#main" into a link to the home page.
  var skip = document.querySelector(".skip");
  var mainEl = document.getElementById("main");
  if (skip && mainEl) {
    skip.addEventListener("click", function (ev) {
      ev.preventDefault();
      if (!mainEl.hasAttribute("tabindex")) mainEl.setAttribute("tabindex", "-1");
      mainEl.focus();
      mainEl.scrollIntoView();
    });
  }

  // Copy buttons on code blocks.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy") ? resolve() : reject(new Error("copy failed")); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }
  var blocks = document.querySelectorAll(".code");
  var copyStatus = null;
  if (blocks.length) {
    // One polite live region, so screen readers hear "Copied".
    copyStatus = document.createElement("span");
    copyStatus.className = "sr-only";
    copyStatus.setAttribute("aria-live", "polite");
    document.body.appendChild(copyStatus);
  }
  var isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  Array.prototype.forEach.call(blocks, function (block) {
    var code = block.querySelector("pre code");
    if (!code) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    var timer = null;
    function show(text, done) {
      btn.textContent = text;
      btn.classList.toggle("is-done", done);
      copyStatus.textContent = "";
      copyStatus.textContent = done ? "Copied" : text;
      clearTimeout(timer);
      timer = setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("is-done"); copyStatus.textContent = ""; }, 1600);
    }
    btn.addEventListener("click", function () {
      copyText(code.textContent.replace(/\n$/, "")).then(function () { show("Copied", true); }, function () {
        try { window.getSelection().selectAllChildren(code); } catch (e) { /* no selection API */ }
        show(isMac ? "Press ⌘C" : "Press Ctrl+C", false);
      });
    });
    block.appendChild(btn);
  });

  // On-page TOC: mark the section in view.
  var tocLinks = document.querySelectorAll(".toc a");
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    var targets = [];
    Array.prototype.forEach.call(tocLinks, function (a) {
      var id = decodeURIComponent(a.getAttribute("href").slice(1));
      var el = document.getElementById(id);
      if (el) { byId[id] = a; targets.push(el); }
    });
    var visible = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { visible[en.target.id] = en.isIntersecting; });
      var active = null;
      for (var i = 0; i < targets.length; i++) if (visible[targets[i].id]) { active = targets[i].id; break; }
      if (!active) return;
      Array.prototype.forEach.call(tocLinks, function (a) { a.classList.remove("is-active"); });
      if (byId[active]) byId[active].classList.add("is-active");
    }, { rootMargin: "-64px 0px -66% 0px" });
    targets.forEach(function (t) { io.observe(t); });
  }

  // Search.
  var dialog = document.querySelector("dialog.search");
  if (!dialog || typeof dialog.showModal !== "function") {
    Array.prototype.forEach.call(document.querySelectorAll("[data-search-open]"), function (b) { b.hidden = true; });
    return;
  }
  var input = dialog.querySelector("input");
  var list = dialog.querySelector(".search-results");
  var hint = dialog.querySelector(".search-hint");
  var index = null;
  var loading = null;
  var failed = false;
  var selected = -1;

  function load() {
    if (index || loading) return loading;
    failed = false;
    loading = fetch(root + "search-index.json")
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (data) {
        index = data.pages.map(function (p) {
          return { p: p, t: p.t.toLowerCase(), x: p.x.toLowerCase(), h: p.h.map(function (h) { return [h[0], h[1], h[1].toLowerCase()]; }) };
        });
        render();
      })
      .catch(function () {
        failed = true;
        loading = null; // the next open tries again
        render();
      });
    return loading;
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    input.focus();
    input.select();
    load();
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-search-open]"), function (b) { b.addEventListener("click", open); });
  dialog.addEventListener("click", function (ev) { if (ev.target === dialog) dialog.close(); });
  document.addEventListener("keydown", function (ev) {
    var tag = (ev.target && ev.target.tagName) || "";
    var typing = tag === "INPUT" || tag === "TEXTAREA" || (ev.target && ev.target.isContentEditable);
    if ((ev.key === "/" && !typing) || ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k")) {
      ev.preventDefault();
      open();
    } else if (ev.key === "Escape" && navOpen()) {
      setNav(false, "button");
    }
  });

  function esc(s) {
    return s.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  // Finds the matches on the raw text with one regex, then escapes each slice,
  // so a term never matches inside a tag or an entity added by escaping.
  function mark(text, terms) {
    var ts = terms
      .filter(function (t) { return t.length >= 2; })
      .sort(function (a, b) { return b.length - a.length; })
      .map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); });
    if (!ts.length) return esc(text);
    var re = new RegExp(ts.join("|"), "gi");
    var out = "";
    var last = 0;
    var m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      out += esc(text.slice(last, m.index)) + "<mark>" + esc(m[0]) + "</mark>";
      last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
  }
  function snippet(p, terms) {
    var low = p.x.toLowerCase();
    var at = -1;
    for (var i = 0; i < terms.length && at < 0; i++) at = low.indexOf(terms[i]);
    if (at < 0) return p.d;
    var start = Math.max(0, at - 60);
    var s = p.x.slice(start, at + 110);
    return (start > 0 ? "…" : "") + s + (at + 110 < p.x.length ? "…" : "");
  }

  function search(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length || !index) return [];
    var res = [];
    index.forEach(function (e) {
      var score = 0;
      var head = null;
      for (var i = 0; i < terms.length; i++) {
        var t = terms[i];
        var s = 0;
        if (e.t.indexOf(t) >= 0) s += e.t.indexOf(t) === 0 ? 14 : 10;
        for (var j = 0; j < e.h.length; j++) {
          if (e.h[j][2].indexOf(t) >= 0) { s += 5; if (!head) head = e.h[j]; break; }
        }
        if (e.x.indexOf(t) >= 0) s += 1 + Math.min(3, e.x.split(t).length - 2) * 0.5;
        if (!s) return; // every term must match somewhere
        score += s;
      }
      if (terms.length > 1) {
        var phrase = terms.join(" ");
        if (e.t.indexOf(phrase) >= 0) score += 10;
        var best = e.h.filter(function (h) { return h[2].indexOf(phrase) >= 0; })[0];
        if (best) score += 16;
        else best = e.h.filter(function (h) { return terms.every(function (t) { return h[2].indexOf(t) >= 0; }); })[0];
        if (best) head = best;
      }
      res.push({ e: e, score: score, head: head });
    });
    res.sort(function (a, b) { return b.score - a.score; });
    return res.slice(0, 12).map(function (r) {
      return { r: r, terms: terms };
    });
  }

  function setResults(htmlText, text) {
    list.innerHTML = htmlText;
    input.setAttribute("aria-expanded", htmlText ? "true" : "false");
    input.removeAttribute("aria-activedescendant");
    hint.textContent = text;
  }
  function render() {
    var q = input.value.trim();
    selected = -1;
    if (failed) { setResults("", "Search could not load. Try again later, or start from the docs home."); return; }
    if (!q) { setResults("", "Type to search titles, headings and text."); return; }
    if (!index) { setResults("", "Loading…"); return; }
    var found = search(q);
    if (!found.length) { setResults("", "No results for “" + q + "”."); return; }
    setResults(found.map(function (f, i) {
      var p = f.r.e.p;
      var url = root + p.u + (f.r.head ? "#" + f.r.head[0] : "");
      return '<li role="presentation"><a role="option" id="sr-' + i + '" aria-selected="false" href="' + esc(url) + '">' +
        '<span class="sr-title">' + mark(p.t, f.terms) + (f.r.head ? ' <span class="sr-sub">› ' + mark(f.r.head[1], f.terms) + "</span>" : "") + "</span>" +
        '<span class="sr-snip">' + mark(snippet(p, f.terms), f.terms) + "</span></a></li>";
    }).join(""), found.length === 1 ? "1 result" : found.length + " results");
  }
  function select(n) {
    var items = list.querySelectorAll("a[role=option]");
    if (!items.length) return;
    selected = (n + items.length) % items.length;
    Array.prototype.forEach.call(items, function (a, i) { a.setAttribute("aria-selected", i === selected ? "true" : "false"); });
    items[selected].scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", "sr-" + selected);
  }
  input.addEventListener("input", render);
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown") { ev.preventDefault(); select(selected + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); select(selected - 1); }
    else if (ev.key === "Enter") {
      // Always stop the form submit, which would close the dialog.
      ev.preventDefault();
      var items = list.querySelectorAll("a[role=option]");
      var a = items[selected < 0 ? 0 : selected];
      if (a) { window.location.href = a.href; dialog.close(); }
    }
  });
  list.addEventListener("click", function (ev) {
    if (ev.target.closest && ev.target.closest("a")) dialog.close();
  });
})();
