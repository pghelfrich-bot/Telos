// Shared browser helpers: an element factory, a guarded localStorage wrapper,
// and small fetch helpers. Loaded as a classic script so it runs everywhere,
// including the jsdom test environment.
(function () {
  "use strict";
  window.SG = window.SG || {};

  // Element factory. User text is always set through textContent or a text
  // node, never innerHTML, because students will submit script tags.
  SG.el = function (tag, opts, kids) {
    var node = document.createElement(tag);
    opts = opts || {};
    Object.keys(opts).forEach(function (k) {
      var v = opts[k];
      if (v == null) return;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "value") node.value = v;
      else if (k === "hidden") node.hidden = !!v;
      else if (k === "disabled") node.disabled = !!v;
      else if (k === "checked") node.checked = !!v;
      else if (k.slice(0, 2) === "on" && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
      else node.setAttribute(k, v);
    });
    if (kids != null) {
      (Array.isArray(kids) ? kids : [kids]).forEach(function (c) {
        if (c == null || c === false) return;
        node.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
      });
    }
    return node;
  };

  SG.clear = function (node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  // Every localStorage call, reads included, is wrapped because storage throws
  // outright in some embedded contexts and an unguarded read would kill the
  // whole page.
  SG.store = {
    get: function (key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (e) {
        /* ignore */
      }
    },
    remove: function (key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        /* ignore */
      }
    },
  };

  // Theme handling. The default follows the system preference; a click on the
  // toggle pins an explicit choice and remembers it.
  SG.theme = {
    KEY: "telos-theme",
    current: function () {
      var pinned = document.documentElement.getAttribute("data-theme");
      if (pinned === "dark" || pinned === "light") return pinned;
      try {
        if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
      } catch (e) {
        /* ignore */
      }
      return "light";
    },
    set: function (theme) {
      document.documentElement.setAttribute("data-theme", theme);
      SG.store.set(SG.theme.KEY, theme);
    },
    toggleButton: function () {
      var btn = SG.el("button", {
        class: "theme-toggle no-print",
        type: "button",
        "aria-label": "Switch between light and dark mode",
      });
      function refresh() {
        btn.textContent = SG.theme.current() === "dark" ? "Light mode" : "Dark mode";
      }
      btn.addEventListener("click", function () {
        SG.theme.set(SG.theme.current() === "dark" ? "light" : "dark");
        refresh();
      });
      refresh();
      return btn;
    },
  };

  async function safeJson(res) {
    try {
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  // Relative paths keep the page working under any origin.
  SG.api = {
    get: async function (path) {
      var res = await fetch(path, { headers: { accept: "application/json" } });
      return { status: res.status, data: await safeJson(res) };
    },
    send: async function (method, path, body) {
      var res = await fetch(path, {
        method: method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: await safeJson(res) };
    },
  };
})();
