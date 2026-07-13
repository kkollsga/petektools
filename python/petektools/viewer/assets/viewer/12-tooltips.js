  // -------------------------------------------------------------- UI TOOLTIPS
  // Buttons use one accessible, viewport-safe tooltip implementation. Native
  // title bubbles are removed to avoid duplicate hover surfaces. This channel
  // describes controls only; map/3-D data inspection remains click-to-toggle.
  function wireButtonTooltips() {
    var tip = document.getElementById("button-tooltip"), active = null, timer = null;
    if (!tip || tip.__wired) return;
    tip.__wired = true; tip.id = tip.id || "button-tooltip";
    function normalize(button) {
      if (!button || button.tagName !== "BUTTON") return;
      var label = button.getAttribute("data-tooltip") || button.getAttribute("title")
        || button.getAttribute("aria-label") || String(button.textContent || "").trim() || "Button";
      button.setAttribute("data-tooltip", label);
      if (!button.getAttribute("aria-label") && !String(button.textContent || "").trim()) button.setAttribute("aria-label", label);
      button.removeAttribute("title");
    }
    function normalizeTree(node) {
      if (!node || (node.nodeType !== 1 && node.nodeType !== 9)) return;
      if (node.tagName === "BUTTON") normalize(node);
      Array.prototype.forEach.call(node.querySelectorAll ? node.querySelectorAll("button") : [], normalize);
    }
    function hide() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (active) active.removeAttribute("aria-describedby");
      active = null; tip.hidden = true;
    }
    function place(button) {
      var r = button.getBoundingClientRect();
      tip.style.left = "0px"; tip.style.top = "0px"; tip.hidden = false;
      var tr = tip.getBoundingClientRect(), gap = 7;
      var left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, r.left + (r.width - tr.width) / 2));
      var top = r.bottom + gap;
      if (top + tr.height > window.innerHeight - 8) top = Math.max(8, r.top - tr.height - gap);
      tip.style.left = Math.round(left) + "px"; tip.style.top = Math.round(top) + "px";
    }
    function show(button, delayed) {
      hide(); normalize(button);
      var run = function () {
        active = button; tip.textContent = button.getAttribute("data-tooltip");
        button.setAttribute("aria-describedby", tip.id); place(button); timer = null;
      };
      if (delayed) timer = setTimeout(run, 260); else run();
    }
    normalizeTree(document);
    document.addEventListener("pointerover", function (event) {
      var button = event.target.closest && event.target.closest("button");
      if (button && (!event.relatedTarget || !button.contains(event.relatedTarget))) show(button, true);
    });
    document.addEventListener("pointerout", function (event) {
      var button = event.target.closest && event.target.closest("button");
      if (button && (!event.relatedTarget || !button.contains(event.relatedTarget))) hide();
    });
    document.addEventListener("focusin", function (event) {
      var button = event.target.closest && event.target.closest("button"); if (button) show(button, false);
    });
    document.addEventListener("focusout", function (event) { if (active === event.target) hide(); });
    document.addEventListener("keydown", function (event) { if (event.key === "Escape") hide(); });
    window.addEventListener("scroll", hide, true); window.addEventListener("resize", hide);
    new MutationObserver(function (records) {
      records.forEach(function (record) { Array.prototype.forEach.call(record.addedNodes, normalizeTree); });
    }).observe(document.body, { childList: true, subtree: true });
  }
