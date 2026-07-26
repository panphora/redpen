(() => {
  // src/targets.js
  var PAGE = "page";
  function normalizeBasis(basis) {
    if (!basis) return { type: "fraction" };
    if (typeof basis === "string") return { type: basis };
    return { type: basis.type || "fraction", ...basis.viewBox ? { viewBox: basis.viewBox.slice() } : {} };
  }
  function createTargets() {
    const list = [];
    const byId = /* @__PURE__ */ new Map();
    function add(spec) {
      if (!spec || !spec.id) return null;
      if (byId.has(spec.id)) remove(spec.id);
      const t = {
        id: spec.id,
        selector: spec.selector || null,
        node: spec.el || null,
        basis: normalizeBasis(spec.basis),
        page: !!spec.page
      };
      byId.set(t.id, t);
      list.push(t);
      return t;
    }
    function remove(id) {
      const t = byId.get(id);
      if (!t || t.page) return null;
      byId.delete(id);
      list.splice(list.indexOf(t), 1);
      return t;
    }
    function elOf(t) {
      if (!t) return null;
      if (t.page) return document.getElementById("frame") || document.documentElement;
      if (t.selector) {
        try {
          return document.querySelector(t.selector);
        } catch {
          return null;
        }
      }
      return t.node && t.node.isConnected ? t.node : null;
    }
    function svgOf(t) {
      const el = elOf(t);
      if (!el) return null;
      if (el.tagName && el.tagName.toLowerCase() === "svg") return el;
      return el.ownerSVGElement || null;
    }
    function viewBoxOf(t) {
      if (t.basis.viewBox) return t.basis.viewBox;
      const svg = svgOf(t);
      const raw = svg && svg.getAttribute("viewBox");
      if (!raw) return null;
      const n = raw.trim().split(/[\s,]+/).map(Number);
      return n.length === 4 && n.every((v) => !isNaN(v)) ? n : null;
    }
    function rectOf(t) {
      const el = elOf(t);
      if (t.page && el === document.documentElement) {
        return { left: -scrollX, top: -scrollY, width: el.scrollWidth, height: el.scrollHeight };
      }
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    function isViewbox(t) {
      return t && t.basis.type === "viewbox";
    }
    function toBasis(t, cx, cy) {
      if (isViewbox(t)) {
        const svg = svgOf(t);
        const m = svg && svg.getScreenCTM();
        if (!m) return null;
        const p = svg.createSVGPoint();
        p.x = cx;
        p.y = cy;
        const q = p.matrixTransform(m.inverse());
        return { x: q.x, y: q.y };
      }
      const r = rectOf(t);
      if (!r || !r.width || !r.height) return null;
      return { x: (cx - r.left) / r.width, y: (cy - r.top) / r.height };
    }
    function toScreen(t, x, y) {
      if (isViewbox(t)) {
        const svg = svgOf(t);
        const m = svg && svg.getScreenCTM();
        if (!m) return null;
        const p = svg.createSVGPoint();
        p.x = x;
        p.y = y;
        const q = p.matrixTransform(m);
        return { x: q.x, y: q.y };
      }
      const r = rectOf(t);
      if (!r || !r.width || !r.height) return null;
      return { x: r.left + x * r.width, y: r.top + y * r.height };
    }
    function hitTest(cx, cy) {
      let best = null, bestArea = Infinity;
      for (const t of list) {
        if (t.page) continue;
        const el = elOf(t);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
        const area = r.width * r.height;
        if (area <= bestArea) {
          best = t;
          bestArea = area;
        }
      }
      return best || byId.get(PAGE);
    }
    add({ id: PAGE, page: true, basis: { type: "fraction" } });
    return {
      list,
      byId,
      add,
      remove,
      get: (id) => byId.get(id),
      elOf,
      svgOf,
      viewBoxOf,
      rectOf,
      isViewbox,
      toBasis,
      toScreen,
      hitTest
    };
  }

  // src/store.js
  var r1 = (n) => Math.round(n * 10) / 10;
  var r4 = (n) => Math.round(n * 1e4) / 1e4;
  function createStore({ key, storage }) {
    const blobKey = "redpen:" + key;
    const legacyNotesKey = "la-notes:" + key;
    const legacyDrawKey = "la-draw:" + key;
    const state = { counter: 0, targets: /* @__PURE__ */ new Map() };
    function group(id) {
      let g = state.targets.get(id);
      if (!g) {
        g = { notes: [], strokes: [], basis: null };
        state.targets.set(id, g);
      }
      return g;
    }
    function readBlob() {
      let blob = null;
      try {
        blob = JSON.parse(storage.getItem(blobKey) || "null");
      } catch {
      }
      if (!blob || blob.v !== 3) return false;
      state.counter = blob.counter || 0;
      for (const [id, g] of Object.entries(blob.targets || {})) {
        const t = group(id);
        t.notes = g.notes || [];
        t.strokes = g.strokes || [];
        t.basis = g.basis || null;
      }
      return true;
    }
    function migrateLegacy() {
      const page = group(PAGE);
      page.basis = { type: "fraction" };
      let found = false;
      let saved = null;
      try {
        saved = JSON.parse(storage.getItem(legacyNotesKey) || "null");
      } catch {
      }
      if (saved) {
        const items = saved.v === 2 ? saved.items || [] : (saved.annos || []).map((a) => ({
          id: a.id,
          note: a.note,
          type: "region",
          target: { selector: "#gl", tag: "canvas" },
          rect: { w: 560, h: 373 },
          region: { x: a.x, y: a.y, w: a.w, h: a.h }
        }));
        for (const it of items) {
          page.notes.push({
            id: it.id,
            text: it.note || "",
            kind: it.type,
            target: it.target,
            ...it.region ? { box: { ...it.region } } : {},
            ...it.rect ? { rect: it.rect } : {},
            ...it.elements ? { elements: it.elements } : {},
            ...it.truncated ? { truncated: it.truncated } : {}
          });
          found = true;
        }
        state.counter = Math.max(state.counter, saved.counter || 0, ...page.notes.map((n) => n.id || 0));
      }
      let legacyStrokes = null;
      try {
        legacyStrokes = JSON.parse(storage.getItem(legacyDrawKey) || "null");
      } catch {
      }
      if (Array.isArray(legacyStrokes)) {
        for (const s of legacyStrokes) {
          if (!Array.isArray(s) || !s.length) continue;
          page.strokes.push({ id: ++state.counter, points: s.map(([x, y]) => [x, y]), width: 3, px: true });
          found = true;
        }
      }
      return found;
    }
    function normalizePixelStrokes(rect) {
      if (!rect || !rect.width || !rect.height) return false;
      let changed = false;
      for (const g of state.targets.values()) {
        for (const s of g.strokes) {
          if (!s.px) continue;
          s.points = s.points.map(([x, y]) => [r4(x / rect.width), r4(y / rect.height)]);
          delete s.px;
          changed = true;
        }
      }
      return changed;
    }
    const hadV3 = readBlob();
    const migrated = hadV3 ? false : migrateLegacy();
    group(PAGE);
    function toJSON() {
      const targets = {};
      for (const [id, g] of state.targets) {
        if (!g.notes.length && !g.strokes.length) continue;
        targets[id] = {
          ...g.basis ? { basis: g.basis } : {},
          notes: g.notes,
          strokes: g.strokes.map((s) => ({
            id: s.id,
            points: s.points.map(([x, y]) => s.px ? [r1(x), r1(y)] : [r4(x), r4(y)]),
            width: s.width,
            ...s.px ? { px: true } : {}
          }))
        };
      }
      return { v: 3, counter: state.counter, targets };
    }
    return {
      state,
      group,
      migrated,
      normalizePixelStrokes,
      nextId: () => ++state.counter,
      save() {
        storage.setItem(blobKey, JSON.stringify(toJSON()));
      },
      toJSON
    };
  }

  // src/identify.js
  function nthOfType(el) {
    const p = el.parentElement;
    if (!p) return 0;
    const sibs = [...p.children].filter((s) => s.tagName === el.tagName);
    return sibs.length > 1 ? sibs.indexOf(el) + 1 : 0;
  }
  function cssPath(el) {
    if (el === document.body) return "body";
    if (el === document.documentElement) return "html";
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      let seg = n instanceof SVGElement ? n.tagName : n.tagName.toLowerCase();
      if (n.id) {
        parts.unshift(seg + "#" + CSS.escape(n.id));
        break;
      }
      seg += [...n.classList].slice(0, 2).map((c) => "." + CSS.escape(c)).join("");
      const nth = nthOfType(n);
      if (nth) seg += `:nth-of-type(${nth})`;
      parts.unshift(seg);
    }
    return parts.join(" > ");
  }
  function describe(el, lite) {
    const t = { selector: cssPath(el), tag: el.tagName.toLowerCase() };
    if (el.id) t.id = el.id;
    if (el.classList.length) t.classes = [...el.classList];
    const nth = nthOfType(el);
    if (nth) t.nth = nth;
    const text = ((el.innerText ?? el.textContent) || "").replace(/\s+/g, " ").trim().slice(0, lite ? 60 : 100);
    if (text) t.text = text;
    if (lite) return t;
    const ancestors = [];
    for (let n = el.parentElement, i = 0; n && i < 4 && n !== document.body && n !== document.documentElement; n = n.parentElement, i++) {
      const a = { tag: n.tagName.toLowerCase() };
      if (n.id) a.id = n.id;
      if (n.classList.length) a.classes = [...n.classList];
      const an = nthOfType(n);
      if (an) a.nth = an;
      ancestors.push(a);
    }
    if (ancestors.length) t.ancestors = ancestors;
    return t;
  }
  function resolve(target) {
    if (!target || !target.selector) return null;
    try {
      return document.querySelector(target.selector);
    } catch {
      return null;
    }
  }
  function graphicBasis(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (t === "canvas" || t === "img" || t === "video") return n;
      if (t === "svg" && !n.ownerSVGElement) return n;
    }
    return null;
  }
  function topElementAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.closest("[data-la-ui]")) continue;
      return el;
    }
    return document.body;
  }

  // src/note-surface.js
  var round3 = (n) => Math.round(n * 1e3) / 1e3;
  var MAX_AREA_ELEMENTS = 15;
  var POINT_TAGS = /* @__PURE__ */ new Set(["canvas", "img", "video"]);
  var pointGraphic = (el) => !!el && POINT_TAGS.has(el.tagName.toLowerCase());
  var SURFACE_CSS = `
  .laMarkers { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; z-index: 99991; pointer-events: none; }
  .laInkLayer { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; z-index: 99990; pointer-events: none; }
  .laMarks { position: absolute; overflow: visible; pointer-events: none; }
  .laBox { position: absolute; border: 2px solid #e5484d; background: rgba(229, 72, 77, .12); box-sizing: border-box; }
  .laBox.el { background: rgba(229, 72, 77, .06); }
  .laBox.laPoint { width: 13px; height: 13px; margin: -6px 0 0 -6px; border-radius: 50%; background: #e5484d; border-color: #FDFDFC; }
  .laBox .tag { position: absolute; top: -10px; left: -10px; background: #e5484d; color: #fff;
    font: 700 11px/16px -apple-system, sans-serif; text-align: center; min-width: 16px; height: 16px; border-radius: 8px; padding: 0 3px; }
  .laHover { position: absolute; border: 1.5px dashed #e5484d; background: rgba(229, 72, 77, .07); box-sizing: border-box; }
  .laOverlay { position: fixed; inset: 0; z-index: 99992; display: none; touch-action: none; }
`;
  function injectSurfaceStyles() {
    if (document.getElementById("laSurfaceStyle")) return;
    const style = document.createElement("style");
    style.id = "laSurfaceStyle";
    style.textContent = SURFACE_CSS;
    document.head.appendChild(style);
  }
  function chrome(el, cls, id) {
    el.className = cls;
    if (id) el.id = id;
    el.dataset.laUi = "1";
    el.setAttribute("sap-ignore", "");
    return el;
  }
  function createNoteSurface({ mount, targets, store, identify, addNote, afterLayout, visible }) {
    const describe2 = identify || describe;
    injectSurfaceStyles();
    const markers = chrome(document.createElement("div"), "laMarkers", "laMarkers");
    mount.appendChild(markers);
    const overlay = chrome(document.createElement("div"), "laOverlay", "laOverlay");
    if (mount !== document.body) overlay.style.position = "absolute";
    mount.appendChild(overlay);
    function place(el, r) {
      const base = markers.getBoundingClientRect();
      el.style.left = r.left - base.left + "px";
      el.style.top = r.top - base.top + "px";
      el.style.width = r.width + "px";
      el.style.height = r.height + "px";
    }
    function screenRect(t, note) {
      if (!note.box) {
        const el = resolve(note.target);
        if (!el) return null;
        const r2 = el.getBoundingClientRect();
        return { left: r2.left, top: r2.top, width: r2.width, height: r2.height };
      }
      if (targets.isViewbox(t)) {
        const a = targets.toScreen(t, note.box.x, note.box.y);
        const b = targets.toScreen(t, note.box.x + note.box.w, note.box.y + note.box.h);
        if (!a || !b) return null;
        return { left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
      }
      const base = note.target ? resolve(note.target) : null;
      const r = base ? base.getBoundingClientRect() : targets.rectOf(t);
      if (!r || !r.width || !r.height) return null;
      return {
        left: r.left + note.box.x * r.width,
        top: r.top + note.box.y * r.height,
        width: note.box.w * r.width,
        height: note.box.h * r.height
      };
    }
    function screenPoint(t, note) {
      const base = note.target ? resolve(note.target) : null;
      const r = base ? base.getBoundingClientRect() : targets.rectOf(t);
      if (!r || !r.width || !r.height) return null;
      return { x: r.left + note.point.x * r.width, y: r.top + note.point.y * r.height };
    }
    function placePoint(el, x, y) {
      const base = markers.getBoundingClientRect();
      el.style.left = x - base.left + "px";
      el.style.top = y - base.top + "px";
    }
    function layout() {
      markers.querySelectorAll(".laBox").forEach((el) => {
        if (el !== rubber) el.remove();
      });
      for (const [id, g] of store.state.targets) {
        const t = targets.get(id);
        if (!t) continue;
        const show = visible ? visible(id) : true;
        if (!show) continue;
        for (const note of g.notes) {
          if (note.kind === "point" && note.point) {
            const p = screenPoint(t, note);
            if (!p) continue;
            const dot = document.createElement("div");
            dot.className = "laBox laPoint";
            dot.dataset.laTarget = id;
            dot.innerHTML = `<span class="tag">${note.id}</span>`;
            placePoint(dot, p.x, p.y);
            markers.appendChild(dot);
            continue;
          }
          const r = screenRect(t, note);
          if (!r) continue;
          const box = document.createElement("div");
          box.className = "laBox" + (note.kind === "element" ? " el" : "");
          box.dataset.laTarget = id;
          box.innerHTML = `<span class="tag">${note.id}</span>`;
          place(box, r);
          markers.appendChild(box);
        }
      }
      afterLayout?.();
    }
    let hover = null;
    function setHover(r) {
      if (!r) {
        hover?.remove();
        hover = null;
        return;
      }
      if (!hover) {
        hover = document.createElement("div");
        hover.className = "laHover";
        markers.appendChild(hover);
      }
      place(hover, r);
    }
    let press = null, rubber = null;
    overlay.addEventListener("pointermove", (e) => {
      if (press) {
        dragMove(e);
        return;
      }
      const el = topElementAt(e.clientX, e.clientY);
      const basis = graphicBasis(el);
      overlay.style.cursor = basis ? "crosshair" : "pointer";
      setHover((basis || el).getBoundingClientRect());
    });
    overlay.addEventListener("pointerleave", () => {
      if (!press) setHover(null);
    });
    overlay.addEventListener("pointerdown", (e) => {
      try {
        overlay.setPointerCapture(e.pointerId);
      } catch {
      }
      const el = topElementAt(e.clientX, e.clientY);
      press = { x: e.clientX, y: e.clientY, el, basis: graphicBasis(el), area: false, target: targets.hitTest(e.clientX, e.clientY) };
      setHover(null);
    });
    function clampedRegion(e) {
      const b = press.basis.getBoundingClientRect();
      const cx = Math.max(b.left, Math.min(e.clientX, b.right));
      const cy = Math.max(b.top, Math.min(e.clientY, b.bottom));
      const px = Math.max(b.left, Math.min(press.x, b.right));
      const py = Math.max(b.top, Math.min(press.y, b.bottom));
      return { b, left: Math.min(px, cx), top: Math.min(py, cy), width: Math.abs(cx - px), height: Math.abs(cy - py) };
    }
    function freeRect(e) {
      return {
        left: Math.min(press.x, e.clientX),
        top: Math.min(press.y, e.clientY),
        width: Math.abs(e.clientX - press.x),
        height: Math.abs(e.clientY - press.y)
      };
    }
    function escapeCheck(e) {
      if (!press.basis || press.area) return;
      const b = press.basis.getBoundingClientRect();
      if (e.clientX < b.left - 8 || e.clientX > b.right + 8 || e.clientY < b.top - 8 || e.clientY > b.bottom + 8) {
        press.area = true;
      }
    }
    function dragMove(e) {
      if (!rubber) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
        rubber = document.createElement("div");
        rubber.className = "laBox";
        markers.appendChild(rubber);
      }
      escapeCheck(e);
      place(rubber, press.basis && !press.area ? clampedRegion(e) : freeRect(e));
    }
    function viewboxRegion(t, r) {
      const a = targets.toBasis(t, r.left, r.top);
      const b = targets.toBasis(t, r.left + r.width, r.top + r.height);
      if (!a || !b) return null;
      return { x: round3(a.x), y: round3(a.y), w: round3(b.x - a.x), h: round3(b.y - a.y) };
    }
    function gestureOf(kind, r) {
      return {
        el: press.el,
        info: {
          kind,
          x: press.x,
          y: press.y,
          targetId: press.target.id,
          box: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
        }
      };
    }
    function addTap() {
      if (pointGraphic(press.basis)) {
        const b = press.basis.getBoundingClientRect();
        if (b.width && b.height) {
          addNote(PAGE, {
            kind: "point",
            target: describe2(press.basis),
            rect: { w: Math.round(b.width), h: Math.round(b.height) },
            point: {
              x: round3((press.x - b.left) / b.width),
              y: round3((press.y - b.top) / b.height)
            }
          }, gestureOf("point"));
          return;
        }
      }
      addNote(press.target.id, { kind: "element", target: describe2(press.el) }, gestureOf("element"));
    }
    overlay.addEventListener("pointerup", (e) => {
      if (!press) return;
      const t = press.target;
      const viewbox = targets.isViewbox(t);
      if (rubber) {
        escapeCheck(e);
        rubber.remove();
        rubber = null;
        const graphic = press.basis && !press.area;
        const r = graphic ? clampedRegion(e) : freeRect(e);
        if (r.width <= 6 && r.height <= 6) {
          addTap();
        } else if (viewbox && graphic) {
          const box = viewboxRegion(t, r);
          if (box) addNote(t.id, { kind: "region", box }, gestureOf("region", r));
          else addNote(t.id, { kind: "element", target: describe2(press.el) }, gestureOf("element", r));
        } else if (graphic) {
          addNote(PAGE, {
            kind: "region",
            target: describe2(press.basis),
            rect: { w: Math.round(r.b.width), h: Math.round(r.b.height) },
            box: {
              x: round3((r.left - r.b.left) / r.b.width),
              y: round3((r.top - r.b.top) / r.b.height),
              w: round3(r.width / r.b.width),
              h: round3(r.height / r.b.height)
            }
          }, gestureOf("region", r));
        } else {
          addAreaNote(r, gestureOf("area", r));
        }
      } else {
        addTap();
      }
      press = null;
    });
    overlay.addEventListener("pointercancel", () => {
      rubber?.remove();
      rubber = null;
      press = null;
    });
    function elementsInArea(rect) {
      const right = rect.left + rect.width, bottom = rect.top + rect.height;
      const picked = [];
      (function walk(parent) {
        for (const el of parent.children) {
          if (el.dataset && el.dataset.laUi != null) continue;
          const r = el.getBoundingClientRect();
          if (r.width && r.height) {
            const ix = Math.min(right, r.right) - Math.max(rect.left, r.left);
            const iy = Math.min(bottom, r.bottom) - Math.max(rect.top, r.top);
            if (ix > 0 && iy > 0 && ix * iy / (r.width * r.height) >= 0.6 && getComputedStyle(el).visibility !== "hidden") {
              picked.push(el);
              continue;
            }
          } else if (getComputedStyle(el).display === "none") {
            continue;
          }
          if (el.tagName.toLowerCase() !== "svg") walk(el);
        }
      })(document.body);
      return picked;
    }
    function commonAncestor(els) {
      let anc = els[0];
      for (const el of els.slice(1)) {
        while (!anc.contains(el)) anc = anc.parentElement;
      }
      return anc;
    }
    function inFixed(el) {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") return true;
      }
      return false;
    }
    function addAreaNote(r, gesture) {
      const els = elementsInArea(r);
      const fixed = new Set(els.filter(inFixed));
      const flow = els.filter((el) => !fixed.has(el));
      const anchorEls = flow.length ? flow : els;
      let anchor = anchorEls.length ? commonAncestor(anchorEls) : topElementAt(r.left + r.width / 2, r.top + r.height / 2);
      let b = anchor.getBoundingClientRect();
      while ((!b.width || !b.height) && anchor.parentElement) {
        anchor = anchor.parentElement;
        b = anchor.getBoundingClientRect();
      }
      const listed = els.slice(0, MAX_AREA_ELEMENTS);
      const truncated = els.length - listed.length;
      addNote(PAGE, {
        kind: "area",
        target: describe2(anchor),
        rect: { w: Math.round(b.width), h: Math.round(b.height) },
        box: {
          x: round3((r.left - b.left) / b.width),
          y: round3((r.top - b.top) / b.height),
          w: round3(r.width / b.width),
          h: round3(r.height / b.height)
        },
        elements: listed.map((el) => {
          const d = describe2(el, true);
          if (fixed.has(el)) d.fixed = true;
          return d;
        }),
        ...truncated ? { truncated } : {}
      }, gesture);
    }
    function setActive2(v) {
      overlay.style.display = v ? "block" : "none";
      if (!v) {
        setHover(null);
        rubber?.remove();
        rubber = null;
        press = null;
      }
      layout();
    }
    function destroy() {
      setHover(null);
      markers.remove();
      overlay.remove();
    }
    return { markers, overlay, layout, setActive: setActive2, destroy };
  }

  // src/draw-surface.js
  var CFG = {
    width: 3,
    // stroke width, px
    color: "#000",
    lazyRadius: 4,
    // brush trails the pointer by this many px at full speed; the live jitter killer
    minLazyRadius: 1.5,
    // brush trail when the pointer is moving slowly
    resampleStep: 3,
    // finished stroke gets one point per N px of arc length
    smoothWindow: 4,
    // box-filter half-width (points each side) on the finished stroke
    smoothPasses: 2,
    // box-filter iterations
    slowSpeed: 0.15,
    // px/ms — at or below this, smoothing stays at slowBlend
    fastSpeed: 1,
    // px/ms — at or above this, smoothing applies in full
    slowBlend: 0.3,
    // fraction of the full smoothing kept for slow, deliberate strokes
    simplifyTol: 1
    // export-time RDP tolerance, px; points stay untouched internally
  };
  function speedT(v) {
    return Math.max(0, Math.min(1, (v - CFG.slowSpeed) / (CFG.fastSpeed - CFG.slowSpeed)));
  }
  function resample(pts, step) {
    const out = [pts[0]];
    let prev = pts[0], carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const cur = pts[i];
      let d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
      while (carry + d >= step) {
        const t = (step - carry) / d;
        const p = {
          x: prev.x + (cur.x - prev.x) * t,
          y: prev.y + (cur.y - prev.y) * t,
          v: prev.v + (cur.v - prev.v) * t
        };
        out.push(p);
        prev = p;
        d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
        carry = 0;
      }
      carry += d;
      prev = cur;
    }
    out.push(pts[pts.length - 1]);
    return out;
  }
  function boxFilter(pts, win) {
    return pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return { ...p };
      let sx = 0, sy = 0, n = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(pts.length - 1, i + win); j++) {
        sx += pts[j].x;
        sy += pts[j].y;
        n++;
      }
      return { x: sx / n, y: sy / n };
    });
  }
  function smooth(pts) {
    const p = resample(pts, CFG.resampleStep);
    let s = p;
    for (let k = 0; k < CFG.smoothPasses; k++) s = boxFilter(s, CFG.smoothWindow);
    return p.map((q, i) => {
      const a = CFG.slowBlend + (1 - CFG.slowBlend) * speedT(q.v);
      return { x: q.x + (s[i].x - q.x) * a, y: q.y + (s[i].y - q.y) * a, v: q.v };
    });
  }
  function simplify(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a].x, ay = pts[a].y;
      const dx = pts[b].x - ax, dy = pts[b].y - ay;
      const len = Math.hypot(dx, dy);
      let max = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = len === 0 ? Math.hypot(pts[i].x - ax, pts[i].y - ay) : Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
        if (d > max) {
          max = d;
          idx = i;
        }
      }
      if (max > eps) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function bboxOf(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    return [x0, y0, Math.round(x1) - x0, Math.round(y1) - y0];
  }
  function isClosed(pts, bbox) {
    if (pts.length < 3) return false;
    const a = pts[0], b = pts[pts.length - 1];
    const diag = Math.hypot(bbox[2], bbox[3]);
    return Math.hypot(b.x - a.x, b.y - a.y) <= Math.max(2 * CFG.width, 0.15 * diag);
  }
  function toPath(pts, closed) {
    let px = Math.round(pts[0].x), py = Math.round(pts[0].y);
    let d = `M ${px} ${py}`;
    for (let i = 1; i < pts.length; i++) {
      const x = Math.round(pts[i].x), y = Math.round(pts[i].y);
      if (x === px && y === py) continue;
      d += ` L ${x} ${y}`;
      px = x;
      py = y;
    }
    if (closed) d += " Z";
    return d;
  }
  function strokeObj(pts) {
    const s = simplify(pts, CFG.simplifyTol);
    const bbox = bboxOf(s);
    const closed = isClosed(s, bbox);
    return { d: toPath(s, closed), bbox, closed };
  }
  function drawStroke(ctx, pts) {
    ctx.lineWidth = CFG.width;
    ctx.strokeStyle = CFG.color;
    ctx.fillStyle = CFG.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, CFG.width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  function createDrawSurface({ mount, targets, store, ink, onStroke, visible }) {
    const fixed = mount === document.body;
    const canvas = document.createElement("canvas");
    canvas.dataset.laUi = "1";
    canvas.setAttribute("sap-ignore", "");
    Object.assign(canvas.style, {
      position: fixed ? "fixed" : "absolute",
      inset: "0",
      zIndex: 99990,
      pointerEvents: "none",
      cursor: "crosshair",
      touchAction: "none"
    });
    mount.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    function canvasOrigin() {
      if (fixed) return { x: 0, y: 0 };
      const r = canvas.getBoundingClientRect();
      return { x: r.left, y: r.top };
    }
    let live = null;
    let brush = null;
    let bound = null;
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = fixed ? innerWidth : mount.clientWidth;
      const h = fixed ? innerHeight : mount.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }
    let raw = null;
    let speed = 0;
    function follow(x, y, t) {
      const dt = t - raw.t;
      if (dt > 0) {
        speed += (Math.hypot(x - raw.x, y - raw.y) / dt - speed) * 0.3;
        raw = { x, y, t };
      }
      const radius = CFG.minLazyRadius + (CFG.lazyRadius - CFG.minLazyRadius) * speedT(speed);
      const dx = x - brush.x, dy = y - brush.y;
      const d = Math.hypot(dx, dy);
      if (d <= radius) return;
      const k = (d - radius) / d;
      brush.x += dx * k;
      brush.y += dy * k;
      live.push({ x: brush.x, y: brush.y, v: speed });
    }
    canvas.addEventListener("pointerdown", (e) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
      }
      bound = targets.hitTest(e.clientX, e.clientY);
      brush = { x: e.clientX, y: e.clientY };
      raw = { ...brush, t: e.timeStamp };
      speed = 0;
      live = [{ ...brush, v: 0 }];
      redraw();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!live) return;
      let events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (events.length === 0) events = [e];
      for (const ev of events) follow(ev.clientX, ev.clientY, ev.timeStamp);
      redraw();
    });
    function finishStroke() {
      if (!live) return;
      const pts = live.length > 1 ? smooth(live) : live;
      const t = bound || targets.get("page");
      const points = [];
      for (const p of pts) {
        const b = targets.toBasis(t, p.x, p.y);
        if (b) points.push([b.x, b.y]);
      }
      live = null;
      bound = null;
      if (points.length) {
        store.group(t.id).strokes.push({ id: store.nextId(), points, width: CFG.width });
        if (!store.group(t.id).basis) store.group(t.id).basis = { ...t.basis };
      }
      redraw();
      onStroke?.();
    }
    canvas.addEventListener("pointerup", finishStroke);
    canvas.addEventListener("pointercancel", finishStroke);
    function screenPoints(t, s) {
      const out = [];
      if (s.px) {
        const r = targets.rectOf(t);
        if (!r) return out;
        for (const [x, y] of s.points) out.push({ x: r.left + x, y: r.top + y });
        return out;
      }
      for (const [x, y] of s.points) {
        const p = targets.toScreen(t, x, y);
        if (p) out.push(p);
      }
      return out;
    }
    function redraw() {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      const c = canvasOrigin();
      ctx.save();
      ctx.translate(-c.x, -c.y);
      for (const [id, g] of store.state.targets) {
        const t = targets.get(id);
        if (!t) continue;
        const show = visible ? visible(id) : true;
        if (targets.isViewbox(t)) {
          ink.render(t, g.strokes, show);
          continue;
        }
        if (!show) continue;
        for (const s of g.strokes) {
          const pts = screenPoints(t, s);
          if (pts.length) drawStroke(ctx, pts);
        }
      }
      if (live) drawStroke(ctx, live);
      ctx.restore();
    }
    function setActive2(v) {
      canvas.style.pointerEvents = v ? "auto" : "none";
    }
    function destroy() {
      canvas.remove();
    }
    setActive2(false);
    resize();
    return { canvas, resize, redraw, setActive: setActive2, destroy };
  }

  // src/ink-layer.js
  function createInkLayer({ mount, targets }) {
    const anchor = document.createElement("div");
    anchor.className = "laInkLayer";
    anchor.dataset.laUi = "1";
    anchor.setAttribute("sap-ignore", "");
    mount.appendChild(anchor);
    const layers = /* @__PURE__ */ new Map();
    function layerFor(t) {
      let svg = layers.get(t.id);
      if (!svg) {
        svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "laMarks");
        svg.dataset.laTarget = t.id;
        svg.dataset.laUi = "1";
        svg.setAttribute("sap-ignore", "");
        anchor.appendChild(svg);
        layers.set(t.id, svg);
      }
      return svg;
    }
    function place(t, svg) {
      const src = targets.svgOf(t);
      const vb = targets.viewBoxOf(t);
      const m = src && src.getScreenCTM();
      if (!m || !vb) return false;
      const p = src.createSVGPoint();
      p.x = vb[0];
      p.y = vb[1];
      const a = p.matrixTransform(m);
      p.x = vb[0] + vb[2];
      p.y = vb[1] + vb[3];
      const b = p.matrixTransform(m);
      if (!(b.x - a.x) || !(b.y - a.y)) return false;
      const base = anchor.getBoundingClientRect();
      svg.setAttribute("viewBox", vb.join(" "));
      svg.setAttribute("preserveAspectRatio", "none");
      svg.style.left = a.x - base.left + "px";
      svg.style.top = a.y - base.top + "px";
      svg.style.width = b.x - a.x + "px";
      svg.style.height = b.y - a.y + "px";
      return true;
    }
    function pathData(points) {
      if (!points.length) return "";
      let d = `M ${points[0][0]} ${points[0][1]}`;
      for (let i = 1; i < points.length; i++) d += ` L ${points[i][0]} ${points[i][1]}`;
      return d;
    }
    function render(t, strokes, show) {
      const svg = layerFor(t);
      svg.style.display = show ? "" : "none";
      if (!show) return;
      if (!place(t, svg)) {
        svg.style.display = "none";
        return;
      }
      svg.textContent = "";
      for (const s of strokes) {
        if (!s.points || !s.points.length) continue;
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData(s.points));
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", s.color || "#000");
        path.setAttribute("stroke-width", s.width || 3);
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("vector-effect", "non-scaling-stroke");
        path.dataset.laStroke = s.id;
        svg.appendChild(path);
      }
    }
    function drop(id) {
      layers.get(id)?.remove();
      layers.delete(id);
    }
    function destroy() {
      anchor.remove();
      layers.clear();
    }
    return { render, drop, destroy, anchor };
  }

  // src/context.js
  var ATTR = "data-redpen-context";
  function collectContext(startEl, info) {
    const chain = [];
    for (let el = startEl; el && el.nodeType === 1; el = el.parentElement) chain.push(el);
    let out = null;
    for (const el of chain.reverse()) {
      let v = el.redpenContext;
      if (typeof v === "function") {
        try {
          v = v(info);
        } catch (err) {
          console.warn("[redpen] context provider threw", err);
          v = null;
        }
      }
      if (!v && el.hasAttribute(ATTR)) {
        try {
          v = JSON.parse(el.getAttribute(ATTR));
        } catch {
          v = null;
        }
      }
      if (v && typeof v === "object") out = { ...out || {}, ...v };
    }
    return out;
  }

  // src/engine.js
  function create(opts = {}) {
    const key = opts.key ?? location.pathname;
    const mount = opts.mount ?? document.body;
    const storage = opts.storage ?? localStorage;
    const identify = opts.identify;
    const targets = createTargets();
    const store = createStore({ key, storage });
    if (store.migrated) store.save();
    let mode = null;
    let active = null;
    let destroyed = false;
    let normalized = false;
    const pen2 = new EventTarget();
    function emit(name, detail) {
      pen2.dispatchEvent(new CustomEvent(name, { detail }));
    }
    const visible = (id) => active === null || active === id;
    const ink = createInkLayer({ mount, targets });
    const noteSurface = createNoteSurface({
      mount,
      targets,
      store,
      identify,
      visible,
      addNote: (targetId, fields, gesture) => {
        const g = store.group(targetId);
        const t = targets.get(targetId);
        if (t && !g.basis) g.basis = { ...t.basis };
        const context = gesture ? collectContext(gesture.el, gesture.info) : null;
        const item = { id: store.nextId(), text: "", ...fields, ...context ? { context } : {} };
        g.notes.push(item);
        store.save();
        noteSurface.layout();
        emit("change", { action: "add", item });
        emit("item:add", { item });
      },
      afterLayout: () => emit("layout", {})
    });
    const drawSurface = createDrawSurface({
      mount,
      targets,
      store,
      ink,
      visible,
      onStroke: () => {
        store.save();
        emit("change", { action: "stroke" });
      }
    });
    function normalizeOnce() {
      if (normalized) return;
      const r = targets.rectOf(targets.get(PAGE));
      if (store.normalizePixelStrokes(r)) store.save();
      normalized = true;
    }
    function repaint() {
      normalizeOnce();
      noteSurface.layout();
      drawSurface.redraw();
    }
    function onResize() {
      drawSurface.resize();
      repaint();
    }
    function onScroll() {
      repaint();
    }
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    function eachGroup(targetId) {
      if (targetId != null) {
        const g = store.state.targets.get(targetId);
        return g ? [[targetId, g]] : [];
      }
      return [...store.state.targets];
    }
    function findNote(id) {
      for (const [targetId, g] of store.state.targets) {
        const item = g.notes.find((n) => n.id === id);
        if (item) return { targetId, g, item };
      }
      return null;
    }
    const VIEWBOX_RULE = "note boxes and stroke paths are in the target SVG's own user units (its viewBox), the same coordinates the artwork is authored in";
    const FRACTION_RULE = "note boxes are fractions of the target element box, usually 0-1, beyond that when the gesture exceeded it; stroke paths are integer px in the stated viewBox";
    function data(targetId) {
      const out = {};
      for (const [id, g] of eachGroup(targetId)) {
        const t = targets.get(id);
        const basis = g.basis || (t ? t.basis : { type: "fraction" });
        const viewbox = basis.type === "viewbox";
        let vb = viewbox ? t && targets.viewBoxOf(t) || basis.viewBox || null : null;
        let scale = { x: 1, y: 1 };
        if (!viewbox) {
          const r = t ? targets.rectOf(t) : null;
          if (r && r.width && r.height) {
            vb = [0, 0, Math.round(r.width), Math.round(r.height)];
            scale = { x: r.width, y: r.height };
          }
        }
        out[id] = {
          basis: basis.type,
          coords: (viewbox ? VIEWBOX_RULE : FRACTION_RULE) + "; strokes in draw order, each path runs in draw direction",
          ...vb ? { viewBox: vb } : {},
          notes: g.notes.map((n) => ({
            id: n.id,
            text: n.text,
            kind: n.kind,
            ...n.target ? { target: n.target } : {},
            ...n.box ? { box: n.box } : {},
            ...n.point ? { point: n.point } : {},
            ...n.rect ? { rect: n.rect } : {},
            ...n.elements ? { elements: n.elements } : {},
            ...n.truncated ? { truncated: n.truncated } : {},
            ...n.context ? { context: n.context } : {}
          })),
          strokes: g.strokes.map((s) => {
            const k = s.px ? { x: 1, y: 1 } : scale;
            const pts = s.points.map(([x, y]) => ({ x: x * k.x, y: y * k.y }));
            return { id: s.id, ...strokeObj(pts), width: s.width };
          })
        };
      }
      return { targets: out };
    }
    Object.assign(pen2, {
      // ---------- targets ----------
      addTarget(spec) {
        const t = targets.add(spec);
        if (!t) return null;
        const g = store.group(t.id);
        if (!g.basis) g.basis = { ...t.basis };
        repaint();
        return t.id;
      },
      removeTarget(id) {
        const t = targets.remove(id);
        if (!t) return false;
        ink.drop(id);
        if (active === id) {
          active = null;
          emit("target", { target: active });
        }
        repaint();
        return true;
      },
      targets: () => targets.list.map((t) => t.id),
      // show(id) is the one call on panel switch: it re-resolves the target's
      // element, recomputes the transform, repaints its marks and hides the rest.
      // Calling it with the current id is a cheap re-bind after an SVG swap.
      show(id) {
        const next = id == null ? null : id;
        if (next !== null && !targets.get(next)) return false;
        active = next;
        repaint();
        emit("target", { target: active });
        return true;
      },
      target: () => active,
      // ---------- mode ----------
      setMode(v) {
        const next = v || null;
        if (next === mode) return;
        mode = next;
        noteSurface.setActive(mode === "note");
        drawSurface.setActive(mode === "draw");
        emit("mode", { mode });
      },
      mode: () => mode,
      // ---------- data ----------
      items(targetId) {
        const out = [];
        for (const [id, g] of eachGroup(targetId)) for (const n of g.notes) out.push({ ...n, target_id: id });
        return out;
      },
      strokes(targetId) {
        const out = [];
        for (const [id, g] of eachGroup(targetId)) for (const s of g.strokes) out.push({ ...s, target_id: id });
        return out;
      },
      setNote(id, text) {
        const hit = findNote(id);
        if (!hit) return;
        hit.item.text = text;
        store.save();
        emit("change", { action: "note", item: hit.item });
      },
      remove(id) {
        const hit = findNote(id);
        if (!hit) return;
        hit.g.notes = hit.g.notes.filter((n) => n !== hit.item);
        store.save();
        repaint();
        emit("change", { action: "remove", item: hit.item });
      },
      undoStroke(targetId) {
        const groups = eachGroup(targetId).filter(([, g]) => g.strokes.length);
        if (!groups.length) return;
        let pick = groups[0];
        for (const entry of groups) {
          if (entry[1].strokes[entry[1].strokes.length - 1].id > pick[1].strokes[pick[1].strokes.length - 1].id) pick = entry;
        }
        pick[1].strokes.pop();
        store.save();
        repaint();
        emit("change", { action: "undo" });
      },
      clearNotes(targetId) {
        for (const [, g] of eachGroup(targetId)) g.notes = [];
        store.save();
        repaint();
        emit("change", { action: "clear" });
      },
      clearStrokes(targetId) {
        for (const [, g] of eachGroup(targetId)) g.strokes.length = 0;
        store.save();
        repaint();
        emit("change", { action: "clear" });
      },
      clear(targetId) {
        for (const [, g] of eachGroup(targetId)) {
          g.notes = [];
          g.strokes.length = 0;
        }
        if (targetId == null) store.state.counter = 0;
        store.save();
        repaint();
        emit("change", { action: "clear" });
      },
      data,
      layout: repaint,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        window.removeEventListener("resize", onResize);
        window.removeEventListener("scroll", onScroll);
        noteSurface.destroy();
        drawSurface.destroy();
        ink.destroy();
        emit("change", { action: "destroy" });
      }
    });
    let tries = 0;
    (function settle() {
      if (destroyed) return;
      repaint();
      const pending = [...store.state.targets].some(([, g]) => g.notes.some((n) => n.target && !resolve(n.target)));
      if (tries++ < 20 && pending) setTimeout(settle, 500);
    })();
    return pen2;
  }

  // src/ui.js
  var INK = "#17110C";
  var FILL = "#FDFDFC";
  var MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
  var pillStyle = {
    font: `600 11px/1 ${MONO}`,
    letterSpacing: "0.12em",
    padding: "9px 14px",
    border: "1px solid " + INK,
    borderRadius: "999px",
    background: FILL,
    color: INK,
    cursor: "pointer"
  };
  var PANEL_CSS = `
  #laNotes { position: fixed; top: 16px; left: 16px; width: 258px; box-sizing: border-box; z-index: 99993;
    background: rgba(20, 20, 20, .9); color: #F2F2F0; border-radius: 8px; padding: 14px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  #laNotes h2 { font-size: 12px; margin: 0 0 4px; letter-spacing: .04em; text-transform: uppercase; opacity: .7; }
  #laNotes .hint { margin: 0; opacity: .6; }
  #laNoteList:not(:empty) { margin-top: 10px; }
  .laNoteRow { display: grid; grid-template-columns: 18px 1fr 20px; gap: 6px; align-items: center; margin: 5px 0; }
  .laNoteRow .num { color: #e5484d; font-weight: 700; text-align: center; }
  .laNoteRow input { width: 100%; box-sizing: border-box; background: #0d0d0d; color: #F2F2F0;
    border: 1px solid #2c2c2c; border-radius: 4px; padding: 4px 6px; font: inherit; }
  .laNoteRow button { background: none; border: 0; color: #e5484d; cursor: pointer; font-size: 16px; line-height: 1; padding: 0; }
  .laNoteRow.stale { opacity: .45; }
`;
  var tools = [];
  var copyRow = null;
  var toolRow = null;
  var copyBtn = null;
  function ensureUI() {
    if (toolRow) return;
    const bar = document.createElement("div");
    bar.dataset.laUi = "1";
    bar.setAttribute("sap-ignore", "");
    Object.assign(bar.style, {
      position: "fixed",
      right: "14px",
      bottom: "14px",
      zIndex: 99995,
      display: "flex",
      flexDirection: "column",
      alignItems: "flex-end",
      gap: "8px"
    });
    copyRow = document.createElement("div");
    Object.assign(copyRow.style, { display: "flex", gap: "10px", alignItems: "center" });
    toolRow = document.createElement("div");
    Object.assign(toolRow.style, { display: "flex", gap: "8px", alignItems: "center" });
    copyBtn = document.createElement("button");
    copyBtn.textContent = "COPY JSON";
    Object.assign(copyBtn.style, pillStyle, { background: INK, color: FILL });
    copyBtn.addEventListener("click", () => {
      const flash = (t) => {
        copyBtn.textContent = t;
        setTimeout(() => {
          copyBtn.textContent = "COPY JSON";
        }, 1200);
      };
      if (!navigator.clipboard) return flash("COPY FAILED");
      navigator.clipboard.writeText(json()).then(() => flash("COPIED \u2713"), () => flash("COPY FAILED"));
    });
    copyRow.appendChild(copyBtn);
    bar.append(copyRow, toolRow);
    document.body.appendChild(bar);
  }
  function register(tool) {
    ensureUI();
    const entry = { ...tool, checked: true };
    tools.push(entry);
    const pick = document.createElement("label");
    Object.assign(pick.style, {
      display: "flex",
      alignItems: "center",
      gap: "4px",
      font: `600 10px/1 ${MONO}`,
      letterSpacing: "0.1em",
      color: INK,
      cursor: "pointer"
    });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    Object.assign(cb.style, { accentColor: INK, margin: "0" });
    cb.addEventListener("change", () => {
      entry.checked = cb.checked;
    });
    pick.append(cb, document.createTextNode(entry.label));
    copyRow.insertBefore(pick, copyBtn);
    const clearBtn = document.createElement("button");
    clearBtn.textContent = "\xD7";
    clearBtn.title = "clear " + entry.label.toLowerCase();
    Object.assign(clearBtn.style, pillStyle, {
      padding: "0",
      width: "31px",
      height: "31px",
      fontSize: "15px",
      letterSpacing: "0"
    });
    clearBtn.addEventListener("click", () => entry.clear());
    entry.pill = document.createElement("button");
    Object.assign(entry.pill.style, pillStyle);
    entry.pill.addEventListener("click", () => setActive(entry, !entry.getOn()));
    toolRow.append(clearBtn, entry.pill);
    syncPill(entry);
    return { setOn: (v) => setActive(entry, v) };
  }
  function setActive(entry, v) {
    if (v) {
      for (const t of tools) if (t !== entry && t.getOn()) {
        t.setOn(false);
        syncPill(t);
      }
    }
    entry.setOn(v);
    syncPill(entry);
  }
  function syncPill(t) {
    const on = t.getOn();
    t.pill.textContent = on ? t.labelOn || t.label : t.label;
    t.pill.style.background = on ? INK : FILL;
    t.pill.style.color = on ? FILL : INK;
  }
  function syncPills() {
    for (const t of tools) if (t.pill) syncPill(t);
  }
  var dataSource = null;
  function setDataSource(fn) {
    dataSource = fn;
  }
  function json() {
    const out = { file: location.pathname.split("/").pop() || location.pathname };
    if (dataSource) {
      Object.assign(out, dataSource(Object.fromEntries(tools.map((t) => [t.id, t.checked]))));
    }
    for (const t of tools) if (t.checked && t.getData) out[t.id] = t.getData();
    return JSON.stringify(out, null, 2);
  }
  function off() {
    for (const t of tools) if (t.getOn()) {
      t.setOn(false);
      syncPill(t);
    }
  }
  function attachNotesPanel(pen2) {
    if (!document.getElementById("laPanelStyle")) {
      const style = document.createElement("style");
      style.id = "laPanelStyle";
      style.textContent = PANEL_CSS;
      document.head.appendChild(style);
    }
    const panel = document.createElement("aside");
    panel.id = "laNotes";
    panel.dataset.laUi = "1";
    panel.setAttribute("sap-ignore", "");
    panel.innerHTML = `<h2>Notes</h2>
  <p class="hint">Toggle NOTES, then click an element or drag a box across an area. COPY JSON sends it all back.</p>
  <div id="laNoteList"></div>`;
    document.body.appendChild(panel);
    const list = panel.querySelector("#laNoteList");
    const rowEls = /* @__PURE__ */ new Map();
    function renderRows() {
      list.innerHTML = "";
      rowEls.clear();
      for (const it of pen2.items()) {
        const row = document.createElement("div");
        row.className = "laNoteRow";
        row.title = it.target && it.target.selector || it.target_id;
        const num = document.createElement("span");
        num.className = "num";
        num.textContent = it.id;
        const input = document.createElement("input");
        input.value = it.text;
        input.placeholder = "what's wrong here";
        input.addEventListener("input", () => pen2.setNote(it.id, input.value));
        const del = document.createElement("button");
        del.textContent = "\xD7";
        del.title = "delete";
        del.addEventListener("click", () => pen2.remove(it.id));
        row.append(num, input, del);
        list.appendChild(row);
        rowEls.set(it.id, { row, item: it });
      }
      markStale();
    }
    function markStale() {
      for (const { row, item } of rowEls.values()) row.classList.toggle("stale", !!item.target && !resolve(item.target));
    }
    pen2.addEventListener("change", (e) => {
      const { action, item } = e.detail;
      if (action === "note") return;
      if (action === "add" || action === "remove" || action === "clear") {
        renderRows();
        if (action === "add") rowEls.get(item.id)?.row.querySelector("input").focus();
      }
    });
    pen2.addEventListener("layout", markStale);
    renderRows();
    return { panel, renderRows };
  }
  function attachKeys(pen2) {
    const onKey = (e) => {
      if (pen2.mode() !== "draw") return;
      if (e.target.closest && e.target.closest("input, textarea")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        pen2.undoStroke();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }

  // src/standalone.js
  var instance = null;
  function pen() {
    if (!instance) {
      instance = create({ key: window.REDPEN_KEY ?? location.pathname, mount: document.body });
      instance.addEventListener("mode", syncPills);
      attachKeys(instance);
      setDataSource((include) => {
        const d = instance.data();
        for (const g of Object.values(d.targets)) {
          if (!include.notes) delete g.notes;
          if (!include.draw) delete g.strokes;
        }
        return d;
      });
    }
    return instance;
  }
  function installNotes() {
    if (window.NotesTool) return window.NotesTool;
    const p = pen();
    attachNotesPanel(p);
    const handle = register({
      id: "notes",
      label: "NOTES",
      getOn: () => p.mode() === "note",
      setOn: (v) => p.setMode(v ? "note" : p.mode() === "note" ? null : p.mode()),
      clear: () => p.clearNotes()
    });
    window.NotesTool = {
      on: (v) => handle.setOn(v),
      clear: () => p.clearNotes(),
      layout: () => p.layout(),
      items: () => p.items()
    };
    return window.NotesTool;
  }
  function installDraw() {
    if (window.DrawTool) return window.DrawTool;
    const p = pen();
    const handle = register({
      id: "draw",
      label: "DRAW",
      labelOn: "DRAWING",
      getOn: () => p.mode() === "draw",
      setOn: (v) => p.setMode(v ? "draw" : p.mode() === "draw" ? null : p.mode()),
      clear: () => p.clearStrokes()
    });
    window.DrawTool = {
      cfg: CFG,
      tune: (o) => Object.assign(CFG, o),
      on: (v) => handle.setOn(v),
      undo: () => p.undoStroke(),
      clear: () => p.clearStrokes()
    };
    Object.defineProperty(window.DrawTool, "strokes", { get: () => p.strokes(), enumerable: true });
    return window.DrawTool;
  }
  function installHub() {
    if (!window.FeedbackHub) window.FeedbackHub = { register, json, off, tools };
    return window.FeedbackHub;
  }

  // src/index.js
  installHub();
  installNotes();
  installDraw();
})();
