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

  // src/backend.js
  var DB = "redpen";
  var STORE = "blobs";
  function openDB() {
    return new Promise((resolve2) => {
      let req;
      try {
        if (typeof indexedDB === "undefined" || !indexedDB) return resolve2(null);
        req = indexedDB.open(DB, 1);
      } catch {
        return resolve2(null);
      }
      let settled = false;
      const settle = (db) => {
        if (settled) {
          db?.close?.();
          return;
        }
        settled = true;
        resolve2(db);
      };
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => settle(req.result);
      req.onerror = () => settle(null);
      req.onblocked = () => settle(null);
    });
  }
  function transact(db, mode, fn) {
    return new Promise((resolve2, reject) => {
      let t, req;
      try {
        t = db.transaction(STORE, mode);
        req = fn(t.objectStore(STORE));
      } catch (err) {
        return reject(err);
      }
      t.oncomplete = () => resolve2(req ? req.result : void 0);
      t.onabort = () => reject(t.error || new Error("redpen: idb transaction aborted"));
      t.onerror = () => reject(t.error || new Error("redpen: idb transaction failed"));
    });
  }
  function createBackend({ key, storage }) {
    const blobKey = "redpen:" + key;
    const dbReady = openDB();
    function readLocal() {
      try {
        return JSON.parse(storage.getItem(blobKey) || "null");
      } catch {
        return null;
      }
    }
    return {
      // The durable blob, or null. Never rejects: a read that fails is an empty
      // redpen, not a broken page.
      async read() {
        const db = await dbReady;
        if (!db) return readLocal();
        const found = await transact(db, "readonly", (s) => s.get(blobKey));
        if (found) return found;
        const legacy = readLocal();
        if (legacy) {
          try {
            await transact(db, "readwrite", (s) => s.put(legacy, blobKey));
          } catch {
          }
        }
        return legacy;
      },
      // REJECTS on failure, deliberately: the caller has to be able to tell the
      // user their notes are not being kept.
      async write(blob) {
        const db = await dbReady;
        if (!db) return storage.setItem(blobKey, JSON.stringify(blob));
        await transact(db, "readwrite", (s) => s.put(blob, blobKey));
      }
    };
  }

  // src/store.js
  var r1 = (n) => Math.round(n * 10) / 10;
  var r4 = (n) => Math.round(n * 1e4) / 1e4;
  function createStore({ key, storage, onLoad, onSaveError }) {
    const legacyNotesKey = "la-notes:" + key;
    const legacyDrawKey = "la-draw:" + key;
    const backend = createBackend({ key, storage });
    const state = { counter: 0, targets: /* @__PURE__ */ new Map(), answers: /* @__PURE__ */ Object.create(null) };
    const clearedBeforeLoad = /* @__PURE__ */ new Set();
    function group(id) {
      let g = state.targets.get(id);
      if (!g) {
        g = { notes: [], strokes: [], basis: null };
        state.targets.set(id, g);
      }
      return g;
    }
    function adoptBlob(blob) {
      if (!blob || blob.v !== 3) return false;
      state.counter = blob.counter || 0;
      if (blob.answers) {
        state.answers = Object.assign(/* @__PURE__ */ Object.create(null), blob.answers, state.answers);
        for (const [key2, mem] of Object.entries(state.answers)) {
          if (!mem.q && blob.answers[key2]) mem.q = blob.answers[key2].q;
        }
        for (const key2 of clearedBeforeLoad) delete state.answers[key2];
      }
      clearedBeforeLoad.clear();
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
    group(PAGE);
    let loaded = false;
    let readFailed = false;
    (async function hydrate() {
      let blob = null;
      try {
        blob = await backend.read();
      } catch (err) {
        readFailed = true;
        onSaveError?.(err);
      }
      const migrated = !readFailed && !adoptBlob(blob) && migrateLegacy();
      loaded = true;
      onLoad?.({ migrated, readFailed });
      flush();
    })();
    let dirty = false, writing = false;
    function flush() {
      if (writing || !dirty || !loaded || readFailed) return;
      dirty = false;
      writing = true;
      backend.write(toJSON()).then(
        () => {
          writing = false;
          flush();
        },
        (err) => {
          writing = false;
          onSaveError?.(err);
          flush();
        }
      );
    }
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
      const answers = Object.keys(state.answers).length ? { answers: state.answers } : {};
      return { v: 3, counter: state.counter, ...answers, targets };
    }
    function flushed() {
      return new Promise((resolve2) => {
        const tick = () => writing || dirty ? setTimeout(tick, 0) : resolve2();
        tick();
      });
    }
    return {
      state,
      group,
      loaded: () => loaded,
      flushed,
      answer: (key2) => state.answers[key2] || null,
      setAnswer(key2, record) {
        state.answers[key2] = record;
        clearedBeforeLoad.delete(key2);
      },
      forgetAnswer(key2) {
        delete state.answers[key2];
        if (!loaded) clearedBeforeLoad.add(key2);
      },
      answerKeys: () => Object.keys(state.answers),
      normalizePixelStrokes,
      nextId: () => ++state.counter,
      save() {
        dirty = true;
        flush();
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

  // src/mark.js
  var CLAY = "no-save no-snapshot no-watch";
  var BARE = ["no-save", "no-snapshot", "no-watch"];
  function mark(node) {
    node.setAttribute("sap-ignore", "");
    node.setAttribute("clay", CLAY);
    for (const token of BARE) node.setAttribute(token, "");
    return node;
  }
  function chrome(node) {
    node.dataset.laUi = "1";
    return mark(node);
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
  .laBox.el { background: transparent; }
  /* The tag carries its comment's number, which is what the list, the strip and
     the export all call it. A point marker IS its own tag rather than wearing a
     second one. */
  .laBox .tag { position: absolute; top: -9px; left: -9px; min-width: 17px; height: 17px; padding: 0 3px; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center; border-radius: 9px;
    background: #e5484d; color: #FDFDFC; border: 2px solid #FDFDFC;
    font: 700 10px/13px ui-monospace, "SF Mono", Menlo, monospace; pointer-events: auto; cursor: pointer; }
  .laBox.laPoint { min-width: 17px; height: 17px; width: auto; padding: 0 3px; margin: -8.5px 0 0 -8.5px; border-radius: 9px;
    display: flex; align-items: center; justify-content: center; background: #e5484d; color: #FDFDFC; border-color: #FDFDFC;
    font: 700 10px/13px ui-monospace, "SF Mono", Menlo, monospace; pointer-events: auto; cursor: pointer; }
  .laBox.hot { outline: 2px solid #e5484d; outline-offset: 2px; }
  .laBox .tag.working, .laBox.laPoint.working { animation: laPulse 1.1s ease-in-out infinite; }
  @keyframes laPulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }
  .laBox .tag:hover, .laBox.laPoint:hover { background: #17110C; }
  .laBox .tag.unread, .laBox.laPoint.unread { box-shadow: 0 0 0 3px rgba(229, 72, 77, .4); }
  .laHover { position: absolute; border: 1.5px dashed #e5484d; background: rgba(229, 72, 77, .07); box-sizing: border-box; }
  .laOverlay { position: fixed; inset: 0; z-index: 99992; display: none; touch-action: none; }
  .laReqs { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; z-index: 99991; pointer-events: none; }
  .laReq { position: absolute; margin: -9px 0 0 3px; min-width: 17px; height: 17px; padding: 0 4px; box-sizing: border-box;
    border: 0; border-radius: 9px; background: #e5484d; color: #fff; cursor: pointer;
    font: 700 11px/17px -apple-system, sans-serif; text-align: center; pointer-events: auto; }
  .laReq:hover { background: #17110C; }
  .laReq.done { background: #B7B3AE; }
  .laReq.stale { box-shadow: 0 0 0 2px #E8A33D; }
  .laReq.on { box-shadow: 0 0 0 3px rgba(229, 72, 77, .35); }
`;
  function tailRect(el) {
    const rects = el.getClientRects();
    return rects.length ? rects[rects.length - 1] : el.getBoundingClientRect();
  }
  function injectSurfaceStyles() {
    if (document.getElementById("laSurfaceStyle")) return;
    const style = mark(document.createElement("style"));
    style.id = "laSurfaceStyle";
    style.textContent = SURFACE_CSS;
    document.head.appendChild(style);
  }
  function chrome2(el, cls, id) {
    el.className = cls;
    if (id) el.id = id;
    return chrome(el);
  }
  function createNoteSurface({ mount, targets, store, identify, addNote, afterLayout, visible, requests, onRequestClick, onNoteClick }) {
    const describe2 = identify || describe;
    injectSurfaceStyles();
    const markers = chrome2(document.createElement("div"), "laMarkers", "laMarkers");
    mount.appendChild(markers);
    markers.addEventListener("click", (e) => {
      const hit = e.target.closest("[data-la-note]");
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      onNoteClick?.(Number(hit.dataset.laNote));
    });
    const reqs = chrome2(document.createElement("div"), "laReqs", "laReqs");
    mount.appendChild(reqs);
    const overlay = chrome2(document.createElement("div"), "laOverlay", "laOverlay");
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
      if (note.target && !base) return null;
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
          if (note.resolved) continue;
          if (note.kind === "point" && note.point) {
            const p = screenPoint(t, note);
            if (!p) continue;
            const dot = document.createElement("div");
            dot.className = "laBox laPoint" + (note.unread ? " unread" : "") + (note.id === hot ? " hot" : "") + (note.id === working ? " working" : "");
            dot.dataset.laTarget = id;
            dot.dataset.laNote = note.id;
            dot.textContent = String(note.id);
            placePoint(dot, p.x, p.y);
            markers.appendChild(dot);
            continue;
          }
          const r = screenRect(t, note);
          if (!r) continue;
          const box = document.createElement("div");
          box.className = "laBox" + (note.kind === "element" ? " el" : "") + (note.id === hot ? " hot" : "");
          box.dataset.laTarget = id;
          box.dataset.laNote = note.id;
          const tag = document.createElement("span");
          tag.className = "tag" + (note.unread ? " unread" : "") + (note.id === working ? " working" : "");
          tag.textContent = String(note.id);
          box.appendChild(tag);
          place(box, r);
          markers.appendChild(box);
        }
      }
      layoutRequests();
      afterLayout?.();
    }
    let openKey = null;
    let hot = null, working = null;
    function setHot(id) {
      if (hot === id) return;
      hot = id;
      layout();
    }
    function setWorking(id) {
      if (working === id) return;
      working = id;
      layout();
    }
    function layoutRequests() {
      reqs.textContent = "";
      const base = reqs.getBoundingClientRect();
      for (const r of requests ? requests() : []) {
        const el = r.node && r.node.isConnected ? r.node : resolve(r.target);
        if (!el) continue;
        const b = tailRect(el);
        if (!b.width && !b.height) continue;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "laReq" + (r.answered ? " done" : "") + (r.stale ? " stale" : "") + (r.key === openKey ? " on" : "");
        chip.dataset.laReq = r.key;
        chip.title = r.ask || "";
        chip.textContent = r.answered ? "\u2713" : String(r.n);
        chip.style.left = b.right - base.left + "px";
        chip.style.top = b.top - base.top + "px";
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onRequestClick?.(r.key);
        });
        reqs.appendChild(chip);
      }
    }
    function setOpenRequest(key) {
      if (openKey === key) return;
      openKey = key;
      layoutRequests();
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
      press = { x: e.clientX, y: e.clientY, el, basis: graphicBasis(el), area: false, shift: !!e.shiftKey, target: targets.hitTest(e.clientX, e.clientY) };
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
          sticky: press.shift,
          box: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null
        }
      };
    }
    function addTap() {
      if (pointGraphic(press.basis) && !press.area) {
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
      try {
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
            if (box) addNote(t.id, { kind: "region", box, target: describe2(press.basis) }, gestureOf("region", r));
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
      } finally {
        press = null;
      }
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
    function setActive(v) {
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
      reqs.remove();
      overlay.remove();
    }
    return { markers, overlay, layout, setActive, setOpenRequest, setHot, setWorking, destroy };
  }

  // src/draw-surface.js
  var CFG = {
    width: 3,
    // stroke width, px
    color: "#17110C",
    halo: "#FDFDFC",
    // the wider pass under the ink, so black reads on a dark page
    haloWidth: 2,
    // px added to the stroke width for that pass
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
  function tracePath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  function drawStroke(ctx, pts) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const [color, width] of [[CFG.halo, CFG.width + CFG.haloWidth], [CFG.color, CFG.width]]) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = width;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      tracePath(ctx, pts);
      ctx.stroke();
    }
  }
  function createDrawSurface({ mount, targets, store, ink, onStroke, visible }) {
    const fixed = mount === document.body;
    const canvas = chrome(document.createElement("canvas"));
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
    function setActive(v) {
      canvas.style.pointerEvents = v ? "auto" : "none";
    }
    function destroy() {
      canvas.remove();
    }
    setActive(false);
    resize();
    return { canvas, resize, redraw, setActive, destroy };
  }

  // src/ink-layer.js
  function createInkLayer({ mount, targets }) {
    const anchor = chrome(document.createElement("div"));
    anchor.className = "laInkLayer";
    mount.appendChild(anchor);
    const layers = /* @__PURE__ */ new Map();
    function layerFor(t) {
      let svg = layers.get(t.id);
      if (!svg) {
        svg = chrome(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
        svg.setAttribute("class", "laMarks");
        svg.dataset.laTarget = t.id;
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
        for (const [color, width] of [["#FDFDFC", (s.width || 3) + 2], [s.color || "#17110C", s.width || 3]]) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("d", pathData(s.points));
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", color);
          path.setAttribute("stroke-width", width);
          path.setAttribute("stroke-linecap", "round");
          path.setAttribute("stroke-linejoin", "round");
          path.setAttribute("vector-effect", "non-scaling-stroke");
          path.dataset.laStroke = s.id;
          svg.appendChild(path);
        }
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
      try {
        let v = el.redpenContext;
        if (typeof v === "function") v = v(info);
        if (!v && el.hasAttribute(ATTR)) {
          try {
            v = JSON.parse(el.getAttribute(ATTR));
          } catch {
            v = null;
          }
        }
        if (v && typeof v === "object") out = { ...out || {}, ...v };
      } catch (err) {
        console.warn("[redpen] context provider failed", el, err);
      }
    }
    if (out === null) return null;
    try {
      return JSON.parse(JSON.stringify(out));
    } catch (err) {
      console.warn("[redpen] context dropped: not JSON-serializable", err);
      return null;
    }
  }

  // src/engine.js
  function create(opts = {}) {
    const key = opts.key ?? location.pathname;
    const mount = opts.mount ?? document.body;
    const storage = opts.storage ?? localStorage;
    const identify = opts.identify;
    const targets = createTargets();
    let mode = null;
    let active = null;
    let destroyed = false;
    let normalized = false;
    let saveFailed = false;
    let loaded = false;
    const store = createStore({
      key,
      storage,
      onLoad: ({ migrated }) => {
        if (destroyed) return;
        loaded = true;
        applyMode();
        if (migrated) store.save();
        tries = 0;
        settle();
        emit("change", { action: "load" });
      },
      // Storage is full, or gone. The notes are still in memory and still export,
      // so nothing is lost YET — but only if whoever is reviewing finds out, which
      // is why this is sticky rather than a passing message.
      onSaveError: (err) => {
        if (destroyed) {
          console.warn("[redpen] a write failed after destroy \u2014 the last edit may not have been saved", err);
          return;
        }
        if (!saveFailed) {
          saveFailed = true;
          armUnloadGuard();
          console.warn("[redpen] feedback is no longer being saved \u2014 COPY JSON to keep it", err);
        }
        emit("save:error", { error: err });
      }
    });
    const pen = new EventTarget();
    function emit(name, detail) {
      pen.dispatchEvent(new CustomEvent(name, { detail }));
    }
    const visible = (id) => active === null || active === id;
    let requests = [];
    const answerOf = (key2) => store.answer(key2);
    const describeEl = identify || describe;
    function requestView(r, i) {
      const a = answerOf(r.key);
      return {
        key: r.key,
        n: i + 1,
        ask: r.ask,
        target: r.target,
        answer: a ? a.said : "",
        answered: !!a,
        askedWas: a ? a.q : null,
        stale: !!a && a.q !== r.ask
      };
    }
    function orphans() {
      const declared = new Set(requests.map((r) => r.key));
      return store.answerKeys().filter((key2) => !declared.has(key2)).map((key2) => {
        const a = store.answer(key2);
        return { key: key2, answer: a.said, askedWas: a.q, at: a.at || null };
      });
    }
    const ink = createInkLayer({ mount, targets });
    const noteSurface = createNoteSurface({
      mount,
      targets,
      store,
      identify,
      visible,
      requests: () => requests.map((r, i) => ({ ...requestView(r, i), node: r.node })),
      onRequestClick: (key2) => {
        const i = requests.findIndex((r) => r.key === key2);
        if (i >= 0) emit("request:click", { request: requestView(requests[i], i) });
      },
      // The way back into a comment that already exists. Mirrors request:click,
      // and it is the whole reason marker tags take clicks: without it a comment's
      // popover opens once, while it is being written, and never again.
      onNoteClick: (id) => {
        const hit = findNote(id);
        if (hit) emit("item:click", { item: { ...hit.item, target_id: hit.targetId } });
      },
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
        emit("item:add", { item, sticky: !!(gesture && gesture.info && gesture.info.sticky) });
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
      if (normalized || !store.loaded()) return;
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
    let unloadGuard = null;
    function armUnloadGuard() {
      if (unloadGuard) return;
      unloadGuard = (e) => {
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", unloadGuard);
    }
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
            ...n.context ? { context: n.context } : {},
            // The conversation and whether it was retired are feedback, so they
            // export. This list is a whitelist and review() reads notes through
            // it, so a field missing here is missing from Copy JSON as well, however
            // faithfully the store round-trips it. `unread` and `draft` stay out:
            // one is local read-state and the other is unsent scratch.
            ...n.thread ? { thread: n.thread } : {},
            ...n.resolved ? { resolved: n.resolved } : {}
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
    function review() {
      const items = [];
      requests.forEach((r, i) => {
        const v = requestView(r, i);
        items.push({
          kind: "answer",
          ask: v.key,
          question: v.ask,
          said: v.answer || null,
          ...v.answered ? {} : { skipped: true },
          ...v.stale ? { stale: true, askedWas: v.askedWas } : {},
          anchor: v.target
        });
      });
      for (const o of orphans()) {
        items.push({ kind: "answer", ask: o.key, said: o.answer, orphaned: true, askedWas: o.askedWas, anchor: null });
      }
      const d = data();
      let coords = null;
      const bases = {};
      for (const [id, g] of Object.entries(d.targets)) {
        if (id === PAGE) {
          coords = g.coords;
        } else if (g.notes.length) {
          bases[id] = { basis: g.basis, coords: g.coords, ...g.viewBox ? { viewBox: g.viewBox } : {} };
        }
        for (const n of g.notes) {
          const { id: noteId, text, kind, target, ...geometry } = n;
          items.push({
            kind: "comment",
            id: noteId,
            shape: kind,
            said: text,
            ...id === PAGE ? {} : { target_id: id },
            anchor: target || null,
            ...geometry
          });
        }
      }
      const strokes = [];
      for (const [id, g] of Object.entries(d.targets)) {
        if (!g.strokes.length) continue;
        if (id !== PAGE && !bases[id]) bases[id] = { basis: g.basis, coords: g.coords, ...g.viewBox ? { viewBox: g.viewBox } : {} };
        for (const s of g.strokes) strokes.push({ ...id === PAGE ? {} : { target_id: id }, ...s });
      }
      const pageBox = d.targets[PAGE] && d.targets[PAGE].viewBox;
      const asked = requests.map((r, i) => requestView(r, i));
      return {
        page: location.pathname.split("/").pop() || location.pathname,
        answered: asked.filter((v) => v.answered).length,
        unanswered: asked.filter((v) => !v.answered).length,
        orphaned: orphans().length,
        resolved: items.filter((i) => i.kind === "comment" && i.resolved).length,
        ...strokes.length ? { strokes, ...pageBox ? { viewBox: pageBox } : {} } : {},
        ...coords ? { coords } : {},
        ...Object.keys(bases).length ? { targets: bases } : {},
        items
      };
    }
    Object.assign(pen, {
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
        applyMode();
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
      // The STORED note, handed to a mutator rather than returned. `items()` gives
      // out shallow copies, so a host that sets a field on one changes nothing the
      // store will ever write, and the nested objects it does share by reference
      // make that failure look like it works until it does not. Going through here
      // also means the save and the event cannot be forgotten.
      updateNote(id, fn) {
        const hit = findNote(id);
        if (!hit) return false;
        fn(hit.item);
        store.save();
        emit("change", { action: "note", item: hit.item });
        return true;
      },
      // Every stored note, for a sweep that must not cost one write per note. The
      // mutator returns true when it changed something, and a sweep that changed
      // nothing writes nothing and emits nothing, so an ordinary page load does
      // not rewrite the whole blob for no reason.
      updateNotes(fn) {
        let changed = false;
        for (const [, g] of store.state.targets) for (const n of g.notes) if (fn(n)) changed = true;
        if (!changed) return false;
        store.save();
        emit("change", { action: "notes" });
        return true;
      },
      remove(id) {
        const hit = findNote(id);
        if (!hit) return;
        hit.g.notes = hit.g.notes.filter((n) => n !== hit.item);
        store.save();
        repaint();
        emit("change", { action: "remove", item: hit.item });
      },
      // Put removed notes back, for an undo. Each item is what items() handed out,
      // a copy carrying target_id; it returns to its group in id order.
      restore(items) {
        let changed = false;
        for (const it of items || []) {
          const { target_id: targetId, ...note } = it;
          const g = store.group(targetId ?? PAGE);
          if (g.notes.some((n) => n.id === note.id)) continue;
          g.notes.push(note);
          g.notes.sort((a, b) => a.id - b.id);
          changed = true;
        }
        if (!changed) return false;
        store.save();
        repaint();
        emit("change", { action: "restore" });
        return true;
      },
      // purely visual, like openRequest: the marker a list row is hovering, and
      // the marker whose newest request is running
      highlight: (id) => noteSurface.setHot(id ?? null),
      working: (id) => noteSurface.setWorking(id ?? null),
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
      // ---------- requests ----------
      // Declarative and idempotent: the list REPLACES the previous declaration.
      // Safe before hydration, because it writes nothing — an answer that arrives
      // milliseconds later simply lights up a chip that is already on screen.
      setRequests(list) {
        requests = (list || []).filter((spec) => spec && spec.key).map((spec) => {
          const node = spec.el || (spec.selector ? document.querySelector(spec.selector) : null);
          return {
            key: spec.key,
            ask: spec.ask || "",
            // the live node, so a declared request never depends on a css path;
            // `target` is for the export and for re-finding it after a re-render
            node: node || null,
            target: node ? describeEl(node) : spec.selector ? { selector: spec.selector } : null
          };
        });
        tries = 0;
        settle();
        emit("change", { action: "requests" });
        return requests.map(requestView);
      },
      requests: () => requests.map(requestView),
      orphans,
      // purely visual: rings the chip whose question is on screen right now
      openRequest: (key2) => noteSurface.setOpenRequest(key2 ?? null),
      // '' clears the answer. That is the only path that deletes one, and it is
      // always a thing the reviewer clicked.
      answer(key2, text) {
        const i = requests.findIndex((r2) => r2.key === key2);
        const r = i >= 0 ? requests[i] : null;
        const before = r ? requestView(r, i) : null;
        const said = text ?? "";
        if (!said.trim()) {
          store.forgetAnswer(key2);
        } else {
          const prev = store.answer(key2);
          store.setAnswer(key2, {
            said,
            // an orphan being edited keeps the question it was originally asked
            q: r ? r.ask : prev ? prev.q : "",
            at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
        store.save();
        const view = r ? requestView(r, i) : { key: key2, ask: null, answer: said.trim() ? said : "", answered: !!said.trim(), orphaned: true };
        if (before && (before.answered !== view.answered || before.stale !== view.stale)) noteSurface.layout();
        emit("change", { action: "answer", request: view });
      },
      data,
      review,
      layout: repaint,
      // true once the stored blob has been read. Nothing may be WRITTEN before
      // this: the store starts empty and a write from that window commits an empty
      // blob over the real one. Gestures are already held off by applyMode; a host
      // that writes notes from its own code has to ask.
      loaded: () => loaded,
      // Resolves once every pending write has landed. The store writes behind the
      // gesture that caused it, so "I typed it" and "it is on disk" are different
      // moments, and anything that tears the page down between the two loses it.
      flushed: () => store.flushed(),
      // true once a write has failed: the notes are memory-only from here
      saveFailed: () => saveFailed,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        window.removeEventListener("resize", onResize);
        window.removeEventListener("scroll", onScroll);
        if (unloadGuard) window.removeEventListener("beforeunload", unloadGuard);
        noteSurface.destroy();
        drawSurface.destroy();
        ink.destroy();
        emit("change", { action: "destroy" });
      }
    });
    function applyMode() {
      noteSurface.setActive(loaded && mode === "note");
      drawSurface.setActive(loaded && mode === "draw");
    }
    let tries = 0;
    function settle() {
      if (destroyed) return;
      repaint();
      const boxless = (r) => {
        const el = r.node && r.node.isConnected ? r.node : resolve(r.target);
        if (!el) return true;
        const b = el.getBoundingClientRect();
        return !b.width && !b.height;
      };
      const pending = [...store.state.targets].some(([, g]) => g.notes.some((n) => n.target && !resolve(n.target))) || requests.some(boxless);
      if (tries++ < 20 && pending) setTimeout(settle, 500);
    }
    settle();
    return pen;
  }

  // src/index-core.js
  if (!window.Redpen) window.Redpen = { create, cfg: CFG, describe, cssPath, resolve };
})();
