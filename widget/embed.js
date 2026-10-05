/*!
 * Apartment Picker embed loader
 * Usage:
 *   <div data-apt-picker data-building="bor" data-buildings="bor,horizont" data-theme="light" data-offset-top="64"></div>
 *   <script src="https://YOUR-HOST/embed.js" async></script>
 * Events (bubble from the container element):
 *   apt-picker:inquiry  detail: { building, buildingName, apartmentId, apartmentLabel }
 *   apt-picker:stats    detail: { buildings: [...] }
 * API:
 *   AptPicker.setBuilding(element, "horizont")
 */
(function () {
  var script = document.currentScript;
  var ORIGIN = new URL(script ? script.src : location.href).origin;
  var frames = [];

  function mount(el) {
    if (el.__aptFrame) return;
    var p = new URLSearchParams();
    if (el.dataset.building) p.set("b", el.dataset.building);
    if (el.dataset.buildings) p.set("only", el.dataset.buildings);
    if (el.dataset.apartment) p.set("apt", el.dataset.apartment);
    if (el.dataset.theme) p.set("theme", el.dataset.theme);
    if ("demo" in el.dataset) p.set("demo", "1");
    p.set("host", location.href.split("#")[0]);
    var f = document.createElement("iframe");
    f.src = ORIGIN + "/embed.html?" + p.toString();
    f.title = el.dataset.title || "Избор на апартамент";
    f.setAttribute("scrolling", "no");
    f.style.cssText = "display:block;width:100%;height:760px;border:0;overflow:hidden;color-scheme:normal";
    el.appendChild(f);
    el.__aptFrame = f;
    f.__aptEl = el;
    frames.push(f);
  }

  function mountAll() { document.querySelectorAll("[data-apt-picker]").forEach(mount); }

  function frameFor(source) {
    for (var i = 0; i < frames.length; i++) if (frames[i].contentWindow === source) return frames[i];
    return null;
  }

  function sendViewport(f) {
    if (!f.contentWindow) return;
    var r = f.getBoundingClientRect();
    var off = parseInt(f.__aptEl.dataset.offsetTop || "0", 10) || 0;
    var visTop = Math.max(r.top, off);
    var top = visTop - r.top;
    var h = Math.max(240, Math.min(innerHeight, r.bottom) - visTop);
    f.contentWindow.postMessage({ type: "apt-picker:viewport", top: Math.round(top), h: Math.round(h) }, ORIGIN);
  }

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { ticking = false; frames.forEach(sendViewport); });
  }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);

  addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data || {}, f = frameFor(e.source);
    if (!f || typeof d.type !== "string" || d.type.indexOf("apt-picker:") !== 0) return;
    if (d.type === "apt-picker:height") f.style.height = d.h + "px";
    else if (d.type === "apt-picker:ready") sendViewport(f);
    else if (d.type === "apt-picker:scroll") {
      var y = f.getBoundingClientRect().top + scrollY + (d.y || 0) - 16;
      scrollTo({ top: y, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    } else {
      f.__aptEl.dispatchEvent(new CustomEvent(d.type, { detail: d, bubbles: true }));
    }
  });

  window.AptPicker = {
    origin: ORIGIN,
    mount: mountAll,
    setBuilding: function (el, id) {
      var f = el && el.__aptFrame;
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: "apt-picker:set-building", b: id }, ORIGIN);
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll);
  else mountAll();
})();
