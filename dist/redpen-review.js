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
      const el3 = elOf(t);
      if (!el3) return null;
      if (el3.tagName && el3.tagName.toLowerCase() === "svg") return el3;
      return el3.ownerSVGElement || null;
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
      const el3 = elOf(t);
      if (t.page && el3 === document.documentElement) {
        return { left: -scrollX, top: -scrollY, width: el3.scrollWidth, height: el3.scrollHeight };
      }
      if (!el3) return null;
      const r = el3.getBoundingClientRect();
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
        const el3 = elOf(t);
        if (!el3) continue;
        const r = el3.getBoundingClientRect();
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
  var PAGE_BLOCK_ID = "redpen-data";
  function findPageBlock(doc = document) {
    const node = doc.getElementById(PAGE_BLOCK_ID);
    return node && node.tagName === "SCRIPT" && /json/i.test(node.type) ? node : null;
  }
  var blockText = (blob) => JSON.stringify(blob).replace(/</g, "\\u003c");
  async function saveThroughClay() {
    const clay = window.clay;
    if (!clay) return;
    if (clay.ready && typeof clay.ready.then === "function") await clay.ready.catch(() => {
    });
    if (typeof clay.save === "function") await clay.save();
  }
  function createPageBackend({ doc = document, save = saveThroughClay } = {}) {
    const block = () => findPageBlock(doc);
    return {
      async read() {
        const text = block()?.textContent.trim() || "";
        return text ? JSON.parse(text) : null;
      },
      async write(blob) {
        const node = block();
        if (!node) throw new Error("redpen: the #redpen-data block is gone from the page");
        const text = blockText(blob);
        if (node.textContent === text) return;
        node.textContent = text;
        await save();
      }
    };
  }

  // src/store.js
  var r1 = (n) => Math.round(n * 10) / 10;
  var r4 = (n) => Math.round(n * 1e4) / 1e4;
  function createStore({ key, storage, backend: given, onLoad, onSaveError }) {
    const legacyNotesKey = "la-notes:" + key;
    const legacyDrawKey = "la-draw:" + key;
    const backend = given ?? createBackend({ key, storage });
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
  function nthOfType(el3) {
    const p = el3.parentElement;
    if (!p) return 0;
    const sibs = [...p.children].filter((s) => s.tagName === el3.tagName);
    return sibs.length > 1 ? sibs.indexOf(el3) + 1 : 0;
  }
  function cssPath(el3) {
    if (el3 === document.body) return "body";
    if (el3 === document.documentElement) return "html";
    const parts = [];
    for (let n = el3; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
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
  function describe(el3, lite) {
    const t = { selector: cssPath(el3), tag: el3.tagName.toLowerCase() };
    if (el3.id) t.id = el3.id;
    if (el3.classList.length) t.classes = [...el3.classList];
    const nth = nthOfType(el3);
    if (nth) t.nth = nth;
    const text = ((el3.innerText ?? el3.textContent) || "").replace(/\s+/g, " ").trim().slice(0, lite ? 60 : 100);
    if (text) t.text = text;
    if (lite) return t;
    const ancestors = [];
    for (let n = el3.parentElement, i = 0; n && i < 4 && n !== document.body && n !== document.documentElement; n = n.parentElement, i++) {
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
  function graphicBasis(el3) {
    for (let n = el3; n && n.nodeType === 1; n = n.parentElement) {
      const t = n.tagName.toLowerCase();
      if (t === "canvas" || t === "img" || t === "video") return n;
      if (t === "svg" && !n.ownerSVGElement) return n;
    }
    return null;
  }
  function topElementAt(x, y) {
    for (const el3 of document.elementsFromPoint(x, y)) {
      if (el3.closest("[data-la-ui]")) continue;
      return el3;
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
  var pointGraphic = (el3) => !!el3 && POINT_TAGS.has(el3.tagName.toLowerCase());
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
  function tailRect(el3) {
    const rects = el3.getClientRects();
    return rects.length ? rects[rects.length - 1] : el3.getBoundingClientRect();
  }
  function injectSurfaceStyles() {
    if (document.getElementById("laSurfaceStyle")) return;
    const style = mark(document.createElement("style"));
    style.id = "laSurfaceStyle";
    style.textContent = SURFACE_CSS;
    document.head.appendChild(style);
  }
  function chrome2(el3, cls, id) {
    el3.className = cls;
    if (id) el3.id = id;
    return chrome(el3);
  }
  function createNoteSurface({ mount: mount2, targets, store, identify, addNote, afterLayout, visible, requests, onRequestClick, onNoteClick }) {
    const describe2 = identify || describe;
    injectSurfaceStyles();
    const markers = chrome2(document.createElement("div"), "laMarkers", "laMarkers");
    mount2.appendChild(markers);
    markers.addEventListener("click", (e) => {
      const hit = e.target.closest("[data-la-note]");
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      onNoteClick?.(Number(hit.dataset.laNote));
    });
    const reqs = chrome2(document.createElement("div"), "laReqs", "laReqs");
    mount2.appendChild(reqs);
    const overlay = chrome2(document.createElement("div"), "laOverlay", "laOverlay");
    if (mount2 !== document.body) overlay.style.position = "absolute";
    mount2.appendChild(overlay);
    function place(el3, r) {
      const base = markers.getBoundingClientRect();
      el3.style.left = r.left - base.left + "px";
      el3.style.top = r.top - base.top + "px";
      el3.style.width = r.width + "px";
      el3.style.height = r.height + "px";
    }
    function screenRect(t, note) {
      if (!note.box) {
        const el3 = resolve(note.target);
        if (!el3) return null;
        const r2 = el3.getBoundingClientRect();
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
    function placePoint(el3, x, y) {
      const base = markers.getBoundingClientRect();
      el3.style.left = x - base.left + "px";
      el3.style.top = y - base.top + "px";
    }
    function layout() {
      markers.querySelectorAll(".laBox").forEach((el3) => {
        if (el3 !== rubber) el3.remove();
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
        const el3 = r.node && r.node.isConnected ? r.node : resolve(r.target);
        if (!el3) continue;
        const b = tailRect(el3);
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
      const el3 = topElementAt(e.clientX, e.clientY);
      const basis = graphicBasis(el3);
      overlay.style.cursor = basis ? "crosshair" : "pointer";
      setHover((basis || el3).getBoundingClientRect());
    });
    overlay.addEventListener("pointerleave", () => {
      if (!press) setHover(null);
    });
    overlay.addEventListener("pointerdown", (e) => {
      try {
        overlay.setPointerCapture(e.pointerId);
      } catch {
      }
      const el3 = topElementAt(e.clientX, e.clientY);
      press = { x: e.clientX, y: e.clientY, el: el3, basis: graphicBasis(el3), area: false, shift: !!e.shiftKey, target: targets.hitTest(e.clientX, e.clientY) };
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
        for (const el3 of parent.children) {
          if (el3.dataset && el3.dataset.laUi != null) continue;
          const r = el3.getBoundingClientRect();
          if (r.width && r.height) {
            const ix = Math.min(right, r.right) - Math.max(rect.left, r.left);
            const iy = Math.min(bottom, r.bottom) - Math.max(rect.top, r.top);
            if (ix > 0 && iy > 0 && ix * iy / (r.width * r.height) >= 0.6 && getComputedStyle(el3).visibility !== "hidden") {
              picked.push(el3);
              continue;
            }
          } else if (getComputedStyle(el3).display === "none") {
            continue;
          }
          if (el3.tagName.toLowerCase() !== "svg") walk(el3);
        }
      })(document.body);
      return picked;
    }
    function commonAncestor(els) {
      let anc = els[0];
      for (const el3 of els.slice(1)) {
        while (!anc.contains(el3)) anc = anc.parentElement;
      }
      return anc;
    }
    function inFixed(el3) {
      for (let n = el3; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") return true;
      }
      return false;
    }
    function addAreaNote(r, gesture) {
      const els = elementsInArea(r);
      const fixed = new Set(els.filter(inFixed));
      const flow = els.filter((el3) => !fixed.has(el3));
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
        elements: listed.map((el3) => {
          const d = describe2(el3, true);
          if (fixed.has(el3)) d.fixed = true;
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
  function createDrawSurface({ mount: mount2, targets, store, ink, onStroke, visible }) {
    const fixed = mount2 === document.body;
    const canvas = chrome(document.createElement("canvas"));
    Object.assign(canvas.style, {
      position: fixed ? "fixed" : "absolute",
      inset: "0",
      zIndex: 99990,
      pointerEvents: "none",
      cursor: "crosshair",
      touchAction: "none"
    });
    mount2.appendChild(canvas);
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
      const w = fixed ? innerWidth : mount2.clientWidth;
      const h = fixed ? innerHeight : mount2.clientHeight;
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
  function createInkLayer({ mount: mount2, targets }) {
    const anchor = chrome(document.createElement("div"));
    anchor.className = "laInkLayer";
    mount2.appendChild(anchor);
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
    for (let el3 = startEl; el3 && el3.nodeType === 1; el3 = el3.parentElement) chain.push(el3);
    let out = null;
    for (const el3 of chain.reverse()) {
      try {
        let v = el3.redpenContext;
        if (typeof v === "function") v = v(info);
        if (!v && el3.hasAttribute(ATTR)) {
          try {
            v = JSON.parse(el3.getAttribute(ATTR));
          } catch {
            v = null;
          }
        }
        if (v && typeof v === "object") out = { ...out || {}, ...v };
      } catch (err) {
        console.warn("[redpen] context provider failed", el3, err);
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
    const mount2 = opts.mount ?? document.body;
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
      backend: opts.backend,
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
    const ink = createInkLayer({ mount: mount2, targets });
    const noteSurface = createNoteSurface({
      mount: mount2,
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
      mount: mount2,
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
        const el3 = r.node && r.node.isConnected ? r.node : resolve(r.target);
        if (!el3) return true;
        const b = el3.getBoundingClientRect();
        return !b.width && !b.height;
      };
      const pending = [...store.state.targets].some(([, g]) => g.notes.some((n) => n.target && !resolve(n.target))) || requests.some(boxless);
      if (tries++ < 20 && pending) setTimeout(settle, 500);
    }
    settle();
    return pen;
  }

  // src/thread.js
  var CAP = { line: 400, lines: 50, reply: 32 * 1024, say: 2e3, pairs: 8, history: 16 * 1024 };
  var RUNNING = /* @__PURE__ */ new Set(["sent", "acked", "landing"]);
  var UNFINISHED = /* @__PURE__ */ new Set(["queued", "parked", "sent", "acked", "landing"]);
  function createThread({ pen, listeners, prefs, onTurn }) {
    const token = Math.random().toString(36).slice(2, 6);
    let transport = null;
    let inflight = null;
    let detachWhenIdle = false;
    let opener = null;
    const byRequest = /* @__PURE__ */ new Map();
    const now = () => (/* @__PURE__ */ new Date()).toISOString();
    const cut = (s, n) => s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
    function noteById(id) {
      return pen.items().find((n) => n.id === id) || null;
    }
    const showTurn = (noteId, turnId) => onTurn?.(noteId, turnId);
    function withTurn(requestId, fn) {
      const at = byRequest.get(requestId);
      if (!at) return false;
      let touched = false;
      pen.updateNote(at.noteId, (note) => {
        const turn = (note.thread || []).find((t) => t.id === at.turnId);
        if (!turn) return;
        touched = true;
        fn(turn, note);
      });
      if (touched) showTurn(at.noteId, at.turnId);
      return touched;
    }
    function settleTurn(requestId, state, error) {
      const ok = withTurn(requestId, (turn) => {
        turn.state = state;
        turn.endedAt = now();
        if (error) turn.error = cut(String(error), CAP.line);
      });
      byRequest.delete(requestId);
      if (inflight === requestId) inflight = null;
      if (detachWhenIdle && !inflight) {
        disconnect();
        return ok;
      }
      drain();
      return ok;
    }
    const sink = {
      state(requestId, state, error) {
        if (!RUNNING.has(state)) return settleTurn(requestId, state, error);
        return withTurn(requestId, (turn) => {
          turn.state = state;
        });
      },
      progress(requestId, line) {
        const said = cut(String(line ?? "").trim(), CAP.line);
        if (!said) return false;
        return withTurn(requestId, (turn) => {
          const trail = turn.progress || (turn.progress = []);
          trail.push(said);
          if (trail.length > CAP.lines) {
            turn.progressDropped = (turn.progressDropped || 0) + (trail.length - CAP.lines);
            trail.splice(0, trail.length - CAP.lines);
          }
        });
      },
      reply(requestId, text, opts = {}) {
        const said = String(text ?? "");
        if (!said) return false;
        let rang = false, back = false;
        const ok = withTurn(requestId, (turn, note) => {
          turn.reply = cut(opts.append && turn.reply ? turn.reply + said : said, CAP.reply);
          turn.repliedAt = now();
          if (note.resolved) {
            delete note.resolved;
            back = true;
          }
          if (reading === note.id) return;
          rang = !note.unread;
          note.unread = true;
        });
        if (rang || back) pen.layout();
        return ok;
      },
      // The transport's own remark about an exchange, which is how a mangled reply
      // line becomes visible without the thread knowing what a status line is.
      note(requestId, line) {
        const said = cut(String(line ?? "").trim(), CAP.line);
        if (!said) return false;
        return withTurn(requestId, (turn) => {
          turn.note = said;
        });
      }
    };
    let reading = null;
    function historyFor(thread2) {
      if (!thread2 || thread2.length < 2) return null;
      const pairs = thread2.map((t, i) => {
        const last = i === thread2.length - 1;
        const you = last ? t.ask : cut(t.ask, CAP.say);
        if (t.reply) return { you, agent: cut(t.reply, CAP.say) };
        if (UNFINISHED.has(t.state)) return { you };
        if (t.state === "done") return { you, done: true };
        return { you, failed: t.error || "this one did not finish" };
      });
      let earlier = 0;
      while (pairs.length > CAP.pairs || pairs.length > 1 && JSON.stringify(pairs).length > CAP.history) {
        pairs.shift();
        earlier++;
      }
      return { pairs, earlier };
    }
    function sendTurn(noteId, said) {
      if (!transport || detachWhenIdle) return null;
      if (!pen.loaded()) return null;
      const text = String(said ?? "");
      if (!text.trim()) return null;
      const note = noteById(noteId);
      if (!note) return null;
      const turnId = "t" + ((note.thread ? note.thread.length : 0) + 1);
      const queued = !!inflight;
      const turn = {
        id: turnId,
        request: `rp-${token}-${noteId}-${turnId}`,
        // Frozen at send time and never rewritten, so a reworded comment cannot
        // silently claim the agent was answering something it never saw. A stored
        // answer's question follows the same rule for the same reason.
        ask: text,
        at: now(),
        state: queued ? "queued" : "sent"
      };
      let stored = null;
      pen.updateNote(noteId, (n) => {
        stored = n.thread || (n.thread = []);
        stored.push(turn);
        delete n.draft;
        delete n.resolved;
      });
      if (!stored) return null;
      if (queued) showTurn(noteId, turnId);
      else dispatch(noteId, turnId);
      return turn;
    }
    function dispatch(noteId, turnId) {
      const note = noteById(noteId);
      const thread2 = note && note.thread || [];
      const at = thread2.findIndex((t) => t.id === turnId);
      if (at < 0) return;
      const requestId = thread2[at].request;
      byRequest.set(requestId, { noteId, turnId });
      inflight = requestId;
      pen.updateNote(noteId, (n) => {
        for (const t of n.thread || []) if (t.id === turnId) {
          t.state = "sent";
          delete t.stalled;
        }
      });
      showTurn(noteId, turnId);
      const projection = pen.review();
      const history = historyFor(thread2.slice(0, at + 1));
      let ok = null;
      try {
        ok = transport.send({
          id: requestId,
          ask: thread2[at].ask,
          turn: at + 1,
          item: projection.items.find((i) => i.kind === "comment" && i.id === noteId) || null,
          projection,
          ...history ? { history } : {}
        });
      } catch (err) {
        console.warn("[redpen] the transport threw", err);
      }
      if (!ok) settleTurn(requestId, "error", "this could not be sent");
    }
    function drain() {
      if (!transport || inflight || detachWhenIdle) return;
      let pick = null;
      for (const note of pen.items()) {
        for (const turn of note.thread || []) {
          if (turn.state !== "queued") continue;
          if (!pick || turn.at < pick.at) pick = { noteId: note.id, turnId: turn.id, at: turn.at };
        }
      }
      if (pick) dispatch(pick.noteId, pick.turnId);
    }
    function sweepUnfinished() {
      pen.updateNotes((note) => {
        if (!note.thread) return false;
        let changed = false;
        for (const turn of note.thread) {
          if (turn.state === "queued") {
            turn.state = "parked";
            delete turn.stalled;
            changed = true;
            continue;
          }
          if (turn.state === "parked") {
            if (turn.stalled) {
              delete turn.stalled;
              changed = true;
            }
            continue;
          }
          if (!RUNNING.has(turn.state)) continue;
          turn.state = "unknown";
          turn.endedAt = now();
          changed = true;
        }
        return changed;
      });
    }
    function disconnect(force = false) {
      if (!transport) return;
      if (inflight && !force) {
        detachWhenIdle = true;
        return;
      }
      const t = transport;
      transport = null;
      inflight = null;
      detachWhenIdle = false;
      byRequest.clear();
      t.detach?.();
      showTurn(null, null);
    }
    function announce(id) {
      if (!listeners.size && !transport) return;
      const review = pen.review();
      const item = review.items.find((i) => i.kind === "comment" && i.id === id);
      if (!item || !item.said || !item.said.trim()) return;
      for (const fn of [...listeners]) {
        try {
          fn(item, review);
        } catch (err) {
          console.warn("[redpen] onComment failed", err);
        }
      }
      sendTurn(id, item.said);
    }
    function pending() {
      const comments = [], drafts = [];
      for (const n of pen.items()) {
        if (n.resolved) continue;
        const threaded = !!(n.thread && n.thread.length);
        if (!threaded && String(n.text || "").trim()) comments.push(n.id);
        else if (threaded && n.draft && n.draft.trim()) drafts.push(n.id);
      }
      return { comments, drafts, count: comments.length + drafts.length };
    }
    function sendPending() {
      if (!transport || detachWhenIdle || !pen.loaded()) return 0;
      let started = 0;
      const p = pending();
      const went = (id, turnId) => {
        const t = (noteById(id)?.thread || []).find((x) => x.id === turnId);
        return !!t && t.state !== "error";
      };
      for (const id of p.comments) {
        const before = (noteById(id)?.thread || []).length;
        announce(id);
        const after = noteById(id)?.thread || [];
        if (after.length > before && went(id, after[after.length - 1].id)) started++;
      }
      for (const id of p.drafts) {
        const said = noteById(id).draft;
        pen.updateNote(id, (n) => {
          delete n.draft;
        });
        const turn = thread.send(id, said);
        if (turn && went(id, turn.id)) started++;
        else if (!turn) pen.updateNote(id, (n) => {
          n.draft = said;
        });
      }
      return started;
    }
    const thread = {
      // Returns its own disconnect, and refuses a second transport rather than
      // replacing the first: two would each believe they own `inflight`, and the
      // one-request rule is the only thing keeping two agents off one file.
      connect(t) {
        if (!t || typeof t.send !== "function") return () => {
        };
        if (transport) {
          console.warn("[redpen] a transport is already connected");
          return () => {
          };
        }
        transport = t;
        t.attach?.(sink);
        showTurn(null, null);
        return () => {
          if (transport === t) disconnect();
        };
      },
      // The one queued turn a reload left behind. Live queueing drains itself;
      // this is the hand on the button that the reload rule deliberately removed.
      resume(noteId, turnId) {
        if (!transport || inflight) return false;
        const note = noteById(noteId);
        const turn = (note && note.thread || []).find((t) => t.id === turnId);
        if (!turn || turn.state !== "parked") return false;
        dispatch(noteId, turnId);
        return true;
      },
      // Done with this comment, which is not the same as the agent succeeding. A
      // running request is left running: cancel is refused once a request reaches
      // landing, so "resolve cancels" is a promise redpen cannot keep, and the
      // agent is mid-edit of your file either way.
      resolve(noteId, on = true) {
        const ok = pen.updateNote(noteId, (n) => {
          if (on) n.resolved = now();
          else delete n.resolved;
        });
        if (ok) pen.layout();
        return ok;
      },
      send: sendTurn,
      open(noteId) {
        opener?.(noteId);
      },
      setOpener(fn) {
        opener = typeof fn === "function" ? fn : null;
      },
      // A deep copy, because items() shares a note's nested objects by reference:
      // a host that edited what it was given would change what the store writes
      // without ever saving, which looks like it works until it does not.
      of(noteId) {
        const note = noteById(noteId);
        if (!note || !note.thread) return [];
        return Object.freeze(JSON.parse(JSON.stringify(note.thread)).map(Object.freeze));
      },
      connected: () => !!transport,
      busy: () => !!inflight,
      transport: () => transport,
      reading: (id) => {
        reading = id ?? null;
      },
      announce,
      pending,
      sendPending,
      sweepUnfinished,
      disconnect
    };
    return thread;
  }

  // src/popover.js
  var CANCELLABLE = /* @__PURE__ */ new Set(["sent", "acked"]);
  var TURN_LABEL = {
    queued: "waiting for the wire",
    // Its own state rather than `queued` plus a flag. Two things that had to be
    // read together is what let drain() pick up a turn the reload had parked and
    // send it with nobody's hand on the button.
    parked: "waiting for you to send it",
    sent: "sending to the agent",
    acked: "the agent is working",
    landing: "waiting for the change",
    error: "the agent failed",
    // `wire serve` signals rather than kills, and lets a handler that is
    // mid-write finish, so the file may still change after this.
    cancelled: "the agent was asked to stop",
    unknown: "this was still running when the page was closed"
  };
  function turnLine(turn) {
    if (turn.state === "error") return turn.error || TURN_LABEL.error;
    if (turn.state === "landing" && turn.reply) return "answered, waiting for the change";
    if (turn.state === "done") return turn.reply ? "" : "finished with nothing said, the change is on the page";
    return TURN_LABEL[turn.state] || turn.state;
  }
  function dotClass(state) {
    if (RUNNING.has(state)) return "working";
    if (state === "done") return "done";
    if (state === "error") return "error";
    return "";
  }
  var clock = (iso) => {
    const t = iso ? new Date(iso) : null;
    return t && !isNaN(t) ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  };
  var firstLine = (text) => String(text || "").split("\n")[0].trim().slice(0, 72) || "an empty comment";
  function elementLabel(target, kind) {
    const t = target || {};
    const tag = t.tag || kind || "element";
    if (t.id) return tag + "#" + t.id;
    if (t.classes && t.classes.length) return tag + "." + t.classes[0];
    return tag;
  }
  function copyText(text, done, fail) {
    const fallback = () => {
      const ta = chrome(el("textarea"));
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-1000px;left:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
      }
      ta.remove();
      ok ? done() : fail?.();
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }
  var el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  function afterScroll(node, fn) {
    const r = node.getBoundingClientRect();
    const onScreen = r.top >= 0 && r.bottom <= innerHeight;
    if (!onScreen) node.scrollIntoView({ block: "center", behavior: "smooth" });
    let last = null, still = 0, frames = 0;
    const step = () => {
      const y = node.getBoundingClientRect().top;
      if (last !== null && Math.abs(y - last) < 0.5) still++;
      else still = 0;
      last = y;
      if (still >= 3 || frames++ > 120) return fn();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function createPopover({ pen, thread, prefs, toast, onChange, anchor, step }) {
    const pop = chrome(el("div", "rprPop rpPop"));
    pop.hidden = true;
    pop.dataset.rpTheme = "light";
    const eyebrow = el("span", "rprEyebrow");
    const moreBtn = el("button", "rprX rpPopMore", "\u22EF");
    moreBtn.title = "More";
    const closeBtn = el("button", "rprX rpPopClose", "\xD7");
    closeBtn.title = "Close";
    const top = el("div", "rprTop rpPopTop");
    top.append(eyebrow, moreBtn, closeBtn);
    const menu = el("div", "rpPopMenu");
    menu.hidden = true;
    const resolveAct = el("button", null, "Resolve");
    resolveAct.dataset.act = "resolve";
    const copyAct = el("button", null, "Copy this comment");
    copyAct.dataset.act = "copy";
    const deleteAct = el("button", "danger", "Delete\u2026");
    deleteAct.dataset.act = "delete";
    menu.append(resolveAct, copyAct, deleteAct);
    const was = el("div", "rprWas");
    was.hidden = true;
    const wasLabel = el("b", null, "answered when the question read");
    const wasText = el("span");
    const stillBtn = el("button", "rprStill", "still stands");
    was.append(wasLabel, wasText, stillBtn);
    const question = el("p", "rprQ");
    question.hidden = true;
    const threadBox = el("div", "rprThread");
    threadBox.hidden = true;
    const field = el("textarea", "rpField");
    field.placeholder = "what's wrong here";
    const foot = el("div", "rprFoot rpPopFoot");
    const leftBtn = el("button", "rpLeft", "\u2039 prev");
    const spacer = el("span", "rprSpacer");
    const hint = el("span", "rprHint", "\u2318\u21B5 done");
    const rightBtn = el("button", "rpRight", "done");
    foot.append(leftBtn, spacer, hint, rightBtn);
    pop.append(top, menu, was, question, threadBox, field, foot);
    document.body.appendChild(pop);
    let open = null;
    let opened = null;
    let dragged = false;
    const noteById = (id) => pen.items().find((n) => n.id === id) || null;
    const openNoteId = () => open && open.kind === "comment" ? open.id : null;
    const transportCan = (name) => {
      const t = thread.transport();
      return !!(t && typeof t[name] === "function");
    };
    function place(node) {
      const r = tailRect(node);
      const w = pop.offsetWidth, h = pop.offsetHeight;
      let left = Math.min(r.left, innerWidth - w - 16);
      left = Math.max(16, left);
      let top2 = r.bottom + 8;
      if (top2 + h > innerHeight - 16) top2 = Math.max(16, r.top - h - 8);
      pop.style.left = left + "px";
      pop.style.top = top2 + "px";
    }
    function atDock() {
      const node = anchor && anchor();
      const r = node ? node.getBoundingClientRect() : { right: innerWidth - 14, top: innerHeight - 14 };
      pop.style.left = Math.max(16, r.right - pop.offsetWidth) + "px";
      pop.style.top = Math.max(16, r.top - pop.offsetHeight - 8) + "px";
    }
    function show(node) {
      pop.hidden = false;
      if (node) afterScroll(node, () => place(node));
      else atDock();
    }
    function relayout() {
      if (pop.hidden || !open || dragged) return;
      if (open.kind === "ask") {
        const node2 = document.getElementById(open.key);
        if (node2) place(node2);
        return;
      }
      const note = noteById(open.id);
      const sel = note && note.target && note.target.selector;
      const node = sel ? document.querySelector(sel) : null;
      if (node) place(node);
    }
    let drag = null;
    top.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = pop.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    function onDragMove(e) {
      if (!drag) return;
      const w = pop.offsetWidth, h = pop.offsetHeight;
      pop.style.left = Math.max(8, Math.min(e.clientX - drag.dx, innerWidth - w - 8)) + "px";
      pop.style.top = Math.max(8, Math.min(e.clientY - drag.dy, innerHeight - h - 8)) + "px";
    }
    function onDragEnd() {
      if (!drag) return;
      drag = null;
      dragged = true;
    }
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    function flush(force) {
      if (!open) return;
      if (!force && field.value === opened) return;
      opened = field.value;
      if (open.kind === "ask") pen.answer(open.key, field.value);
      else if (open.kind === "comment" && open.threaded) {
        pen.updateNote(open.id, (n) => {
          if (field.value) n.draft = field.value;
          else delete n.draft;
        });
      } else if (open.kind === "comment") pen.setNote(open.id, field.value);
    }
    field.addEventListener("input", () => flush());
    function openAsk(k) {
      leaveOpen();
      const list = pen.requests();
      const r = list.find((x) => x.key === k);
      if (!r) return hide();
      open = { kind: "ask", key: k, answerAtOpen: r.answer || "" };
      thread.reading(null);
      pen.openRequest(k);
      closeMenu();
      moreBtn.hidden = true;
      eyebrow.textContent = `ask ${r.n} of ${list.length}`;
      question.hidden = false;
      question.textContent = r.ask;
      was.hidden = !r.stale;
      wasText.textContent = r.askedWas || "";
      renderThread();
      field.hidden = false;
      field.placeholder = "your answer";
      field.value = opened = r.answer || "";
      leftBtn.hidden = false;
      leftBtn.textContent = "\u2039 prev";
      rightBtn.textContent = "next \u203A";
      hint.textContent = "\u2318\u21B5 next";
      hint.hidden = false;
      dragged = false;
      show(document.getElementById(k));
      field.focus();
      onChange();
    }
    function openComment(item, { fresh = false } = {}) {
      leaveOpen();
      item = noteById(item.id) || item;
      if (item.unread) {
        pen.updateNote(item.id, (n) => {
          delete n.unread;
        });
        pen.layout();
      }
      const threaded = !!(item.thread && item.thread.length);
      open = { kind: "comment", id: item.id, textAtOpen: item.text || "", threaded, fresh };
      thread.reading(item.id);
      pen.openRequest(null);
      closeMenu();
      moreBtn.hidden = false;
      resolveAct.textContent = item.resolved ? "Reopen" : "Resolve";
      eyebrow.textContent = `comment ${item.id} \xB7 ${elementLabel(item.target, item.kind)}`;
      question.hidden = true;
      was.hidden = true;
      renderThread();
      field.hidden = false;
      field.placeholder = threaded ? "reply to the agent\u2026" : "what's wrong here";
      field.value = opened = (threaded ? item.draft : item.text) || "";
      leftBtn.hidden = true;
      rightBtn.textContent = threaded ? "send \u203A" : "done";
      hint.hidden = false;
      hint.textContent = threaded ? "\u2318\u21B5 send" : "\u2318\u21B5 done";
      dragged = false;
      const sel = item.target && item.target.selector;
      show(sel ? document.querySelector(sel) : null);
      scrollThreadToEnd();
      field.focus();
      onChange();
    }
    function hide() {
      pop.hidden = true;
      if (document.activeElement === field) field.blur();
      thread.reading(null);
      pen.openRequest(null);
      onChange();
    }
    function closeIf(id) {
      if (!open || open.kind !== "comment" || open.id !== id) return;
      open = null;
      hide();
    }
    function reseed() {
      if (!open || open.kind !== "ask" || field.value !== opened) return;
      const r = pen.requests().find((x) => x.key === open.key);
      if (r) field.value = opened = open.answerAtOpen = r.answer || "";
    }
    function shouldAnnounce(at, note) {
      if (note.thread && note.thread.length) return false;
      return note.text !== at.textAtOpen;
    }
    function leaveOpen() {
      const at = open;
      flush();
      open = null;
      thread.reading(null);
      if (!at || at.kind !== "comment") return;
      const note = noteById(at.id);
      if (!note) return;
      const threaded = !!(note.thread && note.thread.length);
      if (!threaded && !String(note.text || "").trim()) {
        pen.remove(at.id);
        return;
      }
      if (prefs.hold()) return;
      if (shouldAnnounce(at, note)) thread.announce(at.id);
    }
    function cancelOpen() {
      const at = open;
      open = null;
      if (!at) return hide();
      if (at.kind === "ask") {
        pen.answer(at.key, at.answerAtOpen);
        return hide();
      }
      if (at.kind !== "comment") return hide();
      const note = noteById(at.id);
      if (!note) return hide();
      const threaded = !!(note.thread && note.thread.length);
      if (at.fresh && !threaded) {
        pen.remove(at.id);
        hide();
        if (String(note.text || "").trim()) toast(`comment ${at.id} discarded`, () => pen.restore([note]));
        return;
      }
      if (threaded) pen.updateNote(at.id, (n) => {
        delete n.draft;
      });
      else pen.setNote(at.id, at.textAtOpen);
      hide();
    }
    function leave() {
      leaveOpen();
      hide();
    }
    function cancel() {
      cancelOpen();
    }
    function finish() {
      if (!open) return;
      if (open.kind === "ask") return step(1);
      if (open.kind === "comment" && open.threaded) return sendFollowUp();
      leave();
    }
    function sendFollowUp() {
      if (!open || open.kind !== "comment" || !open.threaded) return;
      const said = field.value;
      if (!said.trim()) return;
      field.value = opened = "";
      if (!thread.send(open.id, said)) field.value = opened = said;
      renderThread();
      onChange();
    }
    function closeMenu() {
      menu.hidden = true;
      menu.textContent = "";
      menu.append(resolveAct, copyAct, deleteAct);
    }
    moreBtn.addEventListener("click", () => {
      if (!open || open.kind !== "comment") return;
      if (!menu.hidden) return closeMenu();
      closeMenu();
      menu.hidden = false;
    });
    resolveAct.addEventListener("click", () => {
      if (!open || open.kind !== "comment") return;
      const id = open.id;
      const note = noteById(id);
      if (!note) return;
      if (note.resolved) {
        thread.resolve(id, false);
        resolveAct.textContent = "Resolve";
        closeMenu();
        onChange();
        return;
      }
      flush();
      open = null;
      thread.reading(null);
      thread.resolve(id, true);
      closeMenu();
      hide();
    });
    copyAct.addEventListener("click", () => {
      if (!open || open.kind !== "comment") return;
      const item = pen.review().items.find((i) => i.kind === "comment" && i.id === open.id);
      if (!item) return;
      copyText(JSON.stringify(item, null, 2), () => {
        copyAct.textContent = "copied \u2713";
        setTimeout(() => {
          copyAct.textContent = "Copy this comment";
        }, 1500);
      });
    });
    deleteAct.addEventListener("click", () => {
      if (!open || open.kind !== "comment") return;
      const id = open.id;
      const row = el("div", "rpConfirm");
      row.append(document.createTextNode(`Delete comment ${id}?`), el("span", "sp"));
      const no = el("button", null, "cancel");
      no.addEventListener("click", closeMenu);
      const yes = el("button", "go", "delete");
      yes.addEventListener("click", () => discard(id));
      row.append(no, yes);
      menu.textContent = "";
      menu.appendChild(row);
    });
    function discard(id) {
      const note = noteById(id);
      const running = (note && note.thread || []).find((t) => CANCELLABLE.has(t.state));
      if (running && transportCan("cancel")) thread.transport().cancel(running.request);
      open = null;
      thread.reading(null);
      pen.remove(id);
      closeMenu();
      hide();
      if (note) toast(`comment ${id} deleted`, () => pen.restore([note]));
    }
    stillBtn.addEventListener("click", () => {
      if (!open || open.kind !== "ask" || !field.value.trim()) return;
      flush(true);
      openAsk(open.key);
    });
    closeBtn.addEventListener("click", leave);
    rightBtn.addEventListener("click", finish);
    leftBtn.addEventListener("click", () => step(-1));
    function whoRow(name, iso) {
      const row = el("div", "rprWho");
      row.append(el("span", null, name), el("span", "rprWhen", clock(iso)));
      return row;
    }
    function paragraphs(into, text, cls) {
      for (const block of String(text).split(/\n{2,}/)) {
        const said = block.trim();
        if (said) into.appendChild(el("p", cls, said));
      }
    }
    function trailFor(turn, box) {
      const n = turn.progress.length + (turn.progressDropped || 0);
      const trail = box || el("details", "rprTrail");
      trail.textContent = "";
      trail.appendChild(el("summary", null, `${n} progress line${n === 1 ? "" : "s"}`));
      if (turn.progressDropped) trail.appendChild(el("p", null, `\u2026${turn.progressDropped} earlier`));
      for (const line of turn.progress) trail.appendChild(el("p", null, line));
      return trail;
    }
    function stateRow(turn) {
      const label = turnLine(turn);
      const cancellable = CANCELLABLE.has(turn.state) && transportCan("cancel");
      const parked = turn.state === "parked";
      if (!label && !cancellable && !parked) return null;
      const row = el("div", "rprTurnState");
      row.append(el("span", ("rprDot " + dotClass(turn.state)).trim()), el("span", null, label));
      if (cancellable) {
        const btn = el("button", null, "cancel");
        btn.addEventListener("click", () => thread.transport().cancel(turn.request));
        row.append(btn);
      } else if (parked) {
        const btn = el("button", null, "send");
        btn.addEventListener("click", () => {
          thread.resume(openNoteId(), turn.id);
          renderThread();
        });
        row.append(btn);
      }
      return row;
    }
    let threadFor = null;
    const turnBlocks = /* @__PURE__ */ new Map();
    const turnTrails = /* @__PURE__ */ new Map();
    const turnDrawn = /* @__PURE__ */ new Map();
    const turnSig = (turn) => [
      turn.state,
      turn.repliedAt || "",
      turn.reply || "",
      turn.note || "",
      (turn.progress || []).length,
      turn.progressDropped || 0
    ].join("\0");
    function forgetThread() {
      threadBox.textContent = "";
      turnBlocks.clear();
      turnTrails.clear();
      turnDrawn.clear();
    }
    function fillTurn(block, turn, them) {
      const trail = turn.progress && turn.progress.length ? trailFor(turn, turnTrails.get(turn.id)) : null;
      if (trail) turnTrails.set(turn.id, trail);
      block.textContent = "";
      block.append(whoRow("you", turn.at));
      paragraphs(block, turn.ask, "rprSaid");
      if (turn.reply) {
        block.append(whoRow(them, turn.repliedAt));
        paragraphs(block, turn.reply, "rprReply");
      }
      if (turn.note) block.appendChild(el("p", "rprMangled", turn.note));
      if (trail) block.appendChild(trail);
      const state = stateRow(turn);
      if (state) block.appendChild(state);
      if (RUNNING.has(turn.state) && turn.progress && turn.progress.length) {
        block.appendChild(el("p", "rprNow", turn.progress[turn.progress.length - 1]));
      }
    }
    function renderThread() {
      const id = openNoteId();
      if (id !== threadFor) {
        forgetThread();
        threadFor = id;
      }
      if (id == null) return threadBox.hidden = true;
      const turns = thread.of(id);
      threadBox.hidden = !turns.length;
      if (!turns.length) return void forgetThread();
      const stick = threadBox.scrollHeight - threadBox.scrollTop - threadBox.clientHeight < 24;
      const t = thread.transport();
      const them = t && t.label || "agent";
      const live = /* @__PURE__ */ new Set();
      let grew = false;
      for (const turn of turns) {
        live.add(turn.id);
        let block = turnBlocks.get(turn.id);
        if (!block) {
          block = el("div", "rprTurn");
          turnBlocks.set(turn.id, block);
          grew = true;
        }
        const drawn = turnSig(turn) + "\0" + them;
        if (turnDrawn.get(turn.id) !== drawn) {
          fillTurn(block, turn, them);
          turnDrawn.set(turn.id, drawn);
        }
        if (block.parentNode !== threadBox) threadBox.appendChild(block);
      }
      for (const [turnId, block] of turnBlocks) {
        if (live.has(turnId)) continue;
        block.remove();
        turnBlocks.delete(turnId);
        turnTrails.delete(turnId);
        turnDrawn.delete(turnId);
      }
      if (stick || grew) scrollThreadToEnd();
    }
    function scrollThreadToEnd() {
      threadBox.scrollTop = threadBox.scrollHeight;
    }
    function onTurn(noteId) {
      if (openNoteId() === noteId) renderThread();
    }
    const onPageHide = () => flush();
    window.addEventListener("pagehide", onPageHide);
    return {
      node: pop,
      openAsk,
      openComment,
      openAt: () => open,
      isOpen: () => !pop.hidden,
      flush,
      leave,
      cancel,
      finish,
      hide,
      closeIf,
      reseed,
      relayout,
      onTurn,
      theme: (v) => {
        pop.dataset.rpTheme = v;
      },
      destroy() {
        window.removeEventListener("pointermove", onDragMove);
        window.removeEventListener("pointerup", onDragEnd);
        window.removeEventListener("pagehide", onPageHide);
        pop.remove();
      }
    };
  }

  // src/dock.js
  var CSS2 = `
  .rpDock, .rprPop, .rprTip, .rpToast {
    --rp-paper: #FDFDFC; --rp-sunk: #EFEDE9; --rp-ink: #17110C; --rp-ink2: #463F38; --rp-faint: #8A857E;
    --rp-line: #DCD8D2; --rp-line2: #C6C1B9; --rp-flag: #D2373D; --rp-flag-soft: rgba(210,55,61,.10);
    --rp-flag-edge: rgba(210,55,61,.34); --rp-ok: #2F7D48;
    --rp-shadow: 0 1px 2px rgba(23,17,12,.06), 0 12px 34px -16px rgba(23,17,12,.30);
    --rp-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  [data-rp-theme="dark"].rpDock, [data-rp-theme="dark"].rprPop, [data-rp-theme="dark"].rprTip,
  [data-rp-theme="dark"].rpToast {
    --rp-paper: #181D25; --rp-sunk: #1F252F; --rp-ink: #E6EAF1; --rp-ink2: #C3CAD5; --rp-faint: #77808E;
    --rp-line: #2A313C; --rp-line2: #3A4350; --rp-flag: #F2646A; --rp-flag-soft: rgba(242,100,106,.14);
    --rp-flag-edge: rgba(242,100,106,.40); --rp-ok: #63C083;
    --rp-shadow: 0 1px 2px rgba(0,0,0,.4), 0 14px 34px -16px rgba(0,0,0,.7);
  }

  /* Scoped, never global: the mockup's bare [hidden] rule would reach into the
     page being reviewed. Buttons and textareas set their own display, which
     outranks the UA rule and would leave a "hidden" control on screen. */
  .rpDock [hidden], .rprPop [hidden], .rpDock[hidden], .rprPop[hidden] { display: none !important; }

  /* the dock */
  .rpDock { position: fixed; right: 14px; z-index: 99995; display: flex; flex-direction: column;
    align-items: stretch; gap: 6px; width: 322px;
    font: 12px/1.45 var(--rp-mono); letter-spacing: .03em; color: var(--rp-ink); }
  /* one class, so a host rule of equal specificity later in the cascade wins */
  .rprBar { bottom: 14px; }
  .rpDock .rpBar { display: flex; align-items: center; gap: 4px; align-self: flex-end;
    background: var(--rp-paper); border: 1px solid var(--rp-line); border-radius: 9px; padding: 4px;
    box-shadow: var(--rp-shadow); }
  .rpDock[data-mode] .rpBar { border-color: var(--rp-flag); box-shadow: var(--rp-shadow), 0 0 0 3px var(--rp-flag-soft); }
  .rpDock.failed .rpBar { border-color: var(--rp-flag); }
  .rpDock .rpIcon { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
    border: 0; border-radius: 6px; background: none; color: var(--rp-ink2); cursor: pointer; padding: 0; }
  .rpDock .rpIcon:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpIcon.on { background: var(--rp-flag); color: var(--rp-paper); }
  .rpDock .rpIcon svg { display: block; }
  .rpDock .rpDiv { width: 1px; height: 19px; background: var(--rp-line); margin: 0 3px; }
  .rpDock .rpList, .rpDock .rpMore, .rpDock .rpCopy, .rpDock .rpSend, .rpDock .rprStep {
    font: inherit; letter-spacing: inherit; border: 0; background: none;
    color: var(--rp-faint); border-radius: 6px; padding: 6px 8px; cursor: pointer; }
  .rpDock .rpList:hover, .rpDock .rpMore:hover, .rpDock .rpCopy:hover,
  .rpDock .rpSend:hover, .rpDock .rprStep:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpList { color: var(--rp-ink); font-variant-numeric: tabular-nums; display: flex; gap: 4px; align-items: center; }
  .rpDock .rpCar { color: var(--rp-faint); font-size: 9px; }
  .rpDock .rpList.on, .rpDock .rpMore.on { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpStepper { display: flex; align-items: center; }
  .rpDock .rprStep { padding: 6px 5px; }
  .rpDock .rprCount { color: var(--rp-ink); padding: 0 2px; font-variant-numeric: tabular-nums; }
  .rpDock .rpWire { margin: 0 5px; cursor: pointer; }
  .rpDock .rpDot, .rprPop .rprDot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    flex: none; background: var(--rp-faint); }
  .rpDock .rpDot.working, .rprPop .rprDot.working { background: var(--rp-flag); animation: rpPulse 1.1s ease-in-out infinite; }
  .rpDock .rpDot.done, .rprPop .rprDot.done, .rpDock .rpDot.ok { background: var(--rp-ok); }
  .rpDock .rpDot.error, .rprPop .rprDot.error { background: var(--rp-flag); }
  .rpDock .rpDot.unsent { background: none; border: 1.5px solid var(--rp-faint); }
  @keyframes rpPulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }

  /* the export pill: one control when there is no agent, two when there is */
  .rpDock .rpExport { display: inline-flex; border: 1px solid var(--rp-line2); border-radius: 6px;
    overflow: hidden; margin-left: 2px; }
  .rpDock .rpExport button { border-radius: 0; padding: 5px 9px; color: var(--rp-ink); }
  .rpDock .rpExport .rpSend:not([hidden]) + .rpCopy { border-left: 1px solid var(--rp-line); }
  .rpDock .rpExport button[disabled] { color: var(--rp-faint); cursor: default; }
  .rpDock .rpExport button[disabled]:hover { background: none; color: var(--rp-faint); }
  .rpDock .rpExport.solid { border-color: var(--rp-ink); }
  .rpDock .rpExport.solid .rpCopy { background: var(--rp-ink); color: var(--rp-paper); }
  .rpDock .rpExport.solid .rpCopy:hover { background: var(--rp-ink); color: var(--rp-paper); }

  /* the strip: the minimized comment area, one line */
  .rpDock .rpStrip { display: flex; align-items: center; gap: 8px; background: var(--rp-paper);
    border: 1px solid var(--rp-line); border-radius: 8px; padding: 7px 9px; box-shadow: var(--rp-shadow);
    cursor: pointer; }
  .rpDock .rpStrip:hover { border-color: var(--rp-line2); }
  .rpDock .rpStrip .rpN { color: var(--rp-flag); font-weight: 700; flex: none; font-variant-numeric: tabular-nums; }
  .rpDock .rpStrip .rpSaid { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; color: var(--rp-ink); }
  .rpDock .rpStrip .rpSaid.dim { color: var(--rp-faint); }
  .rpDock .rpStrip button { font: inherit; letter-spacing: inherit; border: 0; background: none;
    color: var(--rp-faint); border-radius: 5px; padding: 2px 6px; cursor: pointer; flex: none; }
  .rpDock .rpStrip button:hover { background: var(--rp-sunk); color: var(--rp-ink); }

  /* the mode hint */
  .rpDock .rpHint { align-self: flex-end; display: flex; align-items: center; gap: 8px;
    background: var(--rp-ink); color: var(--rp-paper); border-radius: 7px; padding: 6px 10px;
    font-size: 11px; letter-spacing: .05em; box-shadow: var(--rp-shadow); }
  .rpDock .rpHint kbd { font: inherit; border: 1px solid rgba(255,255,255,.35); border-radius: 3px;
    padding: 0 4px; opacity: .85; }

  /* the panel */
  .rpDock .rpPanel { background: var(--rp-paper); border: 1px solid var(--rp-line); border-radius: 9px;
    box-shadow: var(--rp-shadow); overflow: hidden; max-height: min(64vh, 440px);
    display: flex; flex-direction: column; }
  .rpDock .rpPhead { display: flex; align-items: center; gap: 8px; padding: 9px 11px;
    border-bottom: 1px solid var(--rp-line); font-size: 10px; letter-spacing: .14em;
    text-transform: uppercase; color: var(--rp-faint); flex: none; }
  .rpDock .rpPhead .sp { flex: 1; }
  .rpDock .rpPhead button { font: inherit; letter-spacing: inherit; text-transform: inherit; border: 0;
    background: none; color: var(--rp-faint); cursor: pointer; border-radius: 4px; padding: 2px 5px; }
  .rpDock .rpPhead button:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpPbody { overflow-y: auto; padding: 5px; }
  .rpDock .rpItem { display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left;
    border: 0; background: none; color: var(--rp-ink); font: inherit; letter-spacing: inherit;
    border-radius: 6px; padding: 7px 8px; cursor: pointer; }
  .rpDock .rpItem:hover { background: var(--rp-sunk); }
  .rpDock .rpItem .n { color: var(--rp-flag); font-weight: 700; flex: none;
    font-variant-numeric: tabular-nums; min-width: 18px; }
  .rpDock .rpItem .said { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rpDock .rpItem .said.dim { color: var(--rp-faint); }
  .rpDock .rpItem .mini { flex: none; color: var(--rp-faint); font-size: 10.5px; }
  .rpDock .rpRow { display: flex; align-items: center; gap: 6px; padding: 2px 3px; }
  .rpDock .rpRow .rpItem { flex: 1; }
  .rpDock .rpRow .sub { font: inherit; letter-spacing: inherit; border: 0; background: none;
    color: var(--rp-faint); border-radius: 5px; padding: 5px 7px; cursor: pointer; flex: none; }
  .rpDock .rpRow .sub:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpRow .sub.danger:hover { background: var(--rp-flag-soft); color: var(--rp-flag); }
  .rpDock .rpEmpty { padding: 16px 12px; color: var(--rp-faint); text-align: center; font-size: 11.5px; }
  .rpDock .rpNote { padding: 4px 11px 8px; color: var(--rp-faint); font-size: 11px; line-height: 1.5; }

  /* the menu */
  .rpDock .rpMenu { padding: 5px; }
  .rpDock .rpMenu button.mi { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
    border: 0; background: none; color: var(--rp-ink); font: inherit; letter-spacing: inherit;
    border-radius: 6px; padding: 8px 9px; cursor: pointer; }
  .rpDock .rpMenu button.mi:hover { background: var(--rp-sunk); }
  .rpDock .rpMenu button.mi .k { margin-left: auto; color: var(--rp-faint); font-size: 10.5px; }
  .rpDock .rpMenu button.mi.danger:hover { background: var(--rp-flag-soft); color: var(--rp-flag); }
  .rpDock .rpMenu button.mi[disabled] { color: var(--rp-faint); cursor: default; }
  .rpDock .rpMenu button.mi[disabled]:hover { background: none; }
  .rpDock .rpMenu .sep { height: 1px; background: var(--rp-line); margin: 5px 3px; }
  .rpDock .rpMenu .grp { padding: 7px 9px 4px; font-size: 9.5px; letter-spacing: .14em;
    text-transform: uppercase; color: var(--rp-faint); }
  .rpDock .rpMenu .status { display: flex; align-items: center; gap: 9px; padding: 8px 9px;
    color: var(--rp-faint); }
  .rpDock .rpMenu label.mi { display: flex; align-items: center; gap: 9px; padding: 6px 9px;
    cursor: pointer; border-radius: 6px; }
  .rpDock .rpMenu label.mi:hover { background: var(--rp-sunk); }
  .rpDock .rpMenu label.mi input { accent-color: var(--rp-flag); margin: 0; }
  .rpDock .rpConfirm { display: flex; align-items: center; gap: 6px; padding: 8px 9px;
    background: var(--rp-flag-soft); border-radius: 6px; color: var(--rp-ink); }
  .rpDock .rpConfirm .sp { flex: 1; }
  .rpDock .rpConfirm button { font: inherit; letter-spacing: inherit; border: 0; border-radius: 5px;
    padding: 4px 8px; cursor: pointer; background: none; color: var(--rp-faint); }
  .rpDock .rpConfirm button:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rpDock .rpConfirm button.go { background: var(--rp-flag); color: var(--rp-paper); }
  .rpDock .rpConfirm button.go:hover { background: var(--rp-flag); opacity: .86; color: var(--rp-paper); }
  .rpDock .rpKeys { padding: 4px 9px 9px; color: var(--rp-faint); font-size: 11px; line-height: 1.9; }
  .rpDock .rpKeys div { display: flex; gap: 9px; align-items: baseline; }
  .rpDock .rpKeys kbd { font: inherit; border: 1px solid var(--rp-line2); border-radius: 3px;
    padding: 0 4px; color: var(--rp-ink); flex: none; min-width: 74px; text-align: center; }
  .rpDock .rpWarn { padding: 9px 11px; background: var(--rp-flag-soft); color: var(--rp-flag);
    font-size: 11px; line-height: 1.5; border-bottom: 1px solid var(--rp-line); }

  /* the key letters, for the first eight seconds of every load */
  .rpDock.rpTeach .rpIcon { flex-direction: column; height: auto; padding: 4px 0 3px; }
  .rpDock.rpTeach .rpIcon::after { content: attr(data-key); font: 600 9px/1 var(--rp-mono);
    color: var(--rp-faint); margin-top: 2px; }

  /* the on-element popover */
  .rprPop { position: fixed; z-index: 99996; box-sizing: border-box; width: 352px;
    max-width: calc(100vw - 28px); background: var(--rp-paper); border: 1px solid var(--rp-line);
    border-radius: 9px; padding: 11px 12px; box-shadow: var(--rp-shadow);
    font: 12.5px/1.5 var(--rp-mono); letter-spacing: .02em; color: var(--rp-ink); }
  .rprPop .rpPopTop { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; cursor: move; }
  .rprPop .rprEyebrow { flex: 1; font-size: 10px; letter-spacing: .13em; text-transform: uppercase;
    color: var(--rp-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rprPop .rprX { font: inherit; color: var(--rp-faint); background: none; border: 0; cursor: pointer;
    padding: 1px 5px; border-radius: 5px; line-height: 1.2; }
  .rprPop .rprX:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rprPop .rpPopMenu { border: 1px solid var(--rp-line); border-radius: 7px; padding: 4px;
    margin-bottom: 9px; background: var(--rp-sunk); }
  .rprPop .rpPopMenu button { display: flex; width: 100%; text-align: left; border: 0; background: none;
    font: inherit; letter-spacing: inherit; color: var(--rp-ink); border-radius: 5px; padding: 6px 8px;
    cursor: pointer; }
  .rprPop .rpPopMenu button:hover { background: var(--rp-paper); }
  .rprPop .rpPopMenu button.danger:hover { color: var(--rp-flag); }
  .rprPop .rpConfirm { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
    background: var(--rp-flag-soft); border-radius: 5px; color: var(--rp-ink); }
  .rprPop .rpConfirm .sp { flex: 1; }
  .rprPop .rpConfirm button { width: auto; font: inherit; border: 0; border-radius: 5px; padding: 3px 8px;
    cursor: pointer; background: none; color: var(--rp-faint); }
  .rprPop .rpConfirm button.go { background: var(--rp-flag); color: var(--rp-paper); }
  .rprPop .rprQ { margin: 0 0 9px; }
  .rprPop .rprWas { margin: 0 0 7px; padding: 6px 8px; border-left: 2px solid #E8A33D;
    color: var(--rp-faint); font-size: 11.5px; }
  .rprPop .rprWas b { display: block; font-weight: 400; letter-spacing: .1em; text-transform: uppercase;
    font-size: 9.5px; margin-bottom: 3px; }
  .rprPop .rprStill { display: block; margin-top: 5px; font: inherit; color: var(--rp-ink);
    background: none; border: 0; border-bottom: 1px solid #E8A33D; border-radius: 0; padding: 0; cursor: pointer; }
  .rprPop textarea { display: block; width: 100%; box-sizing: border-box; min-height: 74px; resize: vertical;
    font: inherit; color: inherit; background: var(--rp-sunk); border: 1px solid var(--rp-line);
    border-radius: 6px; padding: 8px 9px; }
  .rprPop textarea:focus { outline: 0; border-color: var(--rp-line2); box-shadow: 0 0 0 3px var(--rp-flag-soft); }
  .rprPop .rpPopFoot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .rprPop .rpPopFoot .rprSpacer { flex: 1; }
  .rprPop .rpPopFoot button { font: inherit; letter-spacing: inherit; color: var(--rp-ink);
    background: var(--rp-sunk); border: 1px solid var(--rp-line); border-radius: 6px; padding: 4px 10px;
    cursor: pointer; }
  .rprPop .rpPopFoot button:hover { border-color: var(--rp-line2); }
  .rprPop .rprHint { font-size: 10px; letter-spacing: .11em; text-transform: uppercase; color: var(--rp-faint); }

  /* The thread. Your words are muted and the reply is full ink, because the
     reply is what you opened this to read. */
  .rprPop .rprThread { max-height: 38vh; overflow-y: auto; margin: 0 0 9px; }
  .rprPop .rprTurn + .rprTurn { border-top: 1px solid var(--rp-line); margin-top: 10px; padding-top: 10px; }
  .rprPop .rprWho { display: flex; align-items: baseline; gap: 8px; margin: 0 0 3px; font-size: 9.5px;
    letter-spacing: .13em; text-transform: uppercase; color: var(--rp-faint); }
  .rprPop .rprWhen { margin-left: auto; font-variant-numeric: tabular-nums; }
  .rprPop .rprSaid, .rprPop .rprReply, .rprPop .rprMangled { margin: 0 0 6px; white-space: pre-wrap; }
  .rprPop .rprSaid { color: var(--rp-faint); }
  .rprPop .rprReply { color: var(--rp-ink); }
  .rprPop .rprMangled { color: var(--rp-flag); }
  .rprPop .rprTrail { margin: 0 0 6px; font-size: 11.5px; color: var(--rp-faint); }
  .rprPop .rprTrail summary { cursor: pointer; }
  .rprPop .rprTrail p { margin: 3px 0 0 12px; white-space: pre-wrap; }
  .rprPop .rprTurnState { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--rp-faint); }
  .rprPop .rprTurnState button { font: inherit; color: var(--rp-faint); background: none; border: 0;
    border-radius: 5px; padding: 2px 6px; margin-left: auto; cursor: pointer; }
  .rprPop .rprTurnState button:hover { background: var(--rp-sunk); color: var(--rp-ink); }
  .rprPop .rprNow { margin: 2px 0 0 14px; font-size: 11.5px; color: var(--rp-faint); }

  .rprTip { position: fixed; z-index: 99997; max-width: 320px; pointer-events: none;
    font: 11.5px/1.45 var(--rp-mono); color: var(--rp-ink); background: var(--rp-paper);
    border: 1px solid var(--rp-line); border-radius: 7px; padding: 6px 8px; box-shadow: var(--rp-shadow); }

  /* the undo strip after something destructive */
  .rpToast { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); z-index: 99997;
    display: flex; align-items: center; gap: 10px; background: var(--rp-ink); color: var(--rp-paper);
    border-radius: 8px; padding: 8px 12px; font: 12px/1 var(--rp-mono); letter-spacing: .04em;
    box-shadow: var(--rp-shadow); }
  .rpToast button { font: inherit; letter-spacing: inherit; border: 0; background: none;
    color: var(--rp-paper); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; padding: 0; }

  /* Pointing is read off redpen's own dock, never off a class on the authored
     <body>: body's attributes changing makes the whole body a dirty root, so one
     click on comment mode would protect the entire page from the agent's own edit. */
  body:has(.rprBar[data-pointing]) main { outline: 1px solid var(--rp-flag, #D2373D); outline-offset: 6px; }
`;
  var BUBBLE = '<svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.9 2.6h8.2A1.75 1.75 0 0 1 13.85 4.35v5A1.75 1.75 0 0 1 12.1 11.1H7.35l-2.9 2.3a.32.32 0 0 1-.52-.25V11.1h-.03A1.75 1.75 0 0 1 2.15 9.35v-5A1.75 1.75 0 0 1 3.9 2.6Z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"/></svg>';
  var SQUIGGLE = '<svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 2.2 13.6 4.6 7.0 11.2 3.8 11.9 4.5 8.8 11.2 2.2Z" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round"/><path d="M2.3 13.9c1.05-.95 2.1-.95 3.15 0s2.1.95 3.15 0" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>';
  var SHORTCUTS = [
    ["C", "comment mode on / off"],
    ["D", "draw mode on / off"],
    ["Esc", "back out one step"],
    ["\u2318\u21B5", "done, or send a follow-up"],
    ["\u2318Z", "undo the last stroke, in draw mode"],
    ["N", "next unanswered question, when the page asks any"],
    ["?", "this card"],
    ["shift-click", "place a comment and stay in comment mode"]
  ];
  var DARK = "(prefers-color-scheme: dark)";
  var TYPING = "input, textarea, select, [contenteditable]";
  var INTERACTIVE = 'button, a, input, textarea, select, label, summary, [contenteditable], [role="button"]';
  var el2 = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  var isTyping = (node) => !!node && node.nodeType === 1 && (node.matches(TYPING) || node.isContentEditable) || document.designMode === "on";
  var swatch = null;
  function rgbBytes(css) {
    const m = /^rgba?\(([^)]+)\)$/.exec(css || "");
    if (m) {
      const [r2, g2, b2, a2 = 1] = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      return a2 === 0 ? null : [r2, g2, b2];
    }
    if (!swatch) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      swatch = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!swatch) return null;
    swatch.clearRect(0, 0, 1, 1);
    swatch.fillStyle = "rgba(0,0,0,0)";
    swatch.fillStyle = css;
    swatch.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = swatch.getImageData(0, 0, 1, 1).data;
    return a === 0 ? null : [r, g, b];
  }
  function luminance(css) {
    const rgb = rgbBytes(css);
    if (!rgb) return null;
    const lin = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  }
  function isDark() {
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      const l = luminance(getComputedStyle(node).backgroundColor);
      if (l !== null) return l < 0.4;
    }
    return matchMedia(DARK).matches;
  }
  function markerTitle(note) {
    const said = (note.text || "").trim();
    if (!said) return "an empty comment";
    return said.length > 72 ? said.slice(0, 71) + "\u2026" : said;
  }
  function injectStyles() {
    if (document.getElementById("rpStyle")) return;
    const style = mark(el2("style"));
    style.id = "rpStyle";
    style.textContent = CSS2;
    document.head.prepend(style);
  }
  function createDock({ pen, thread, popover, prefs, tools, attr, clickThrough, keys, active = () => true, mountNode, step }) {
    injectStyles();
    let view = null;
    let current = null;
    let confirmAt = null;
    let live = true;
    let toastNode = null, toastTimer = null;
    let clickThroughRule = null;
    const root = chrome(el2("div", "rpDock rprBar"));
    root.dataset.rpTheme = "light";
    const panel = el2("div", "rpPanel");
    panel.hidden = true;
    const strip = el2("div", "rpStrip");
    strip.hidden = true;
    const stripDot = el2("span", "rpDot rprDot");
    const stripN = el2("span", "rpN");
    const stripSaid = el2("span", "rpSaid");
    const stripAct = el2("button", "rpStripAct");
    stripAct.hidden = true;
    strip.append(stripDot, stripN, stripSaid, stripAct);
    const hint = el2("div", "rpHint");
    hint.hidden = true;
    const bar = el2("div", "rpBar");
    let commentBtn = null, drawBtn = null;
    if (tools.has("comment")) {
      commentBtn = el2("button", "rpIcon rpComment");
      commentBtn.dataset.key = "C";
      commentBtn.title = "Comment (C)";
      commentBtn.setAttribute("aria-label", "Comment");
      commentBtn.innerHTML = BUBBLE;
      bar.appendChild(commentBtn);
    }
    if (tools.has("draw")) {
      drawBtn = el2("button", "rpIcon rpDraw");
      drawBtn.dataset.key = "D";
      drawBtn.title = "Draw (D)";
      drawBtn.setAttribute("aria-label", "Draw");
      drawBtn.innerHTML = SQUIGGLE;
      bar.appendChild(drawBtn);
    }
    const div = el2("span", "rpDiv");
    const stepper = el2("span", "rpStepper");
    stepper.hidden = true;
    const prevBtn = el2("button", "rpPrev rprStep", "\u2039");
    const countText = el2("span", "rpCount rprCount", "0/0");
    const nextBtn = el2("button", "rpNext rprStep", "\u203A");
    stepper.append(prevBtn, countText, nextBtn);
    const listBtn = el2("button", "rpList");
    const listN = el2("span", "rpListN", "0");
    const listCar = el2("span", "rpCar", "\u25B4");
    listBtn.append(listN, listCar);
    const moreBtn = el2("button", "rpMore", "\u22EF");
    moreBtn.title = "More (\u22EF)";
    const wireDot = el2("span", "rpWire rpDot rprDot");
    wireDot.hidden = true;
    wireDot.title = "the agent";
    const exportBox = el2("span", "rpExport");
    const sendBtn = el2("button", "rpSend", "Send");
    sendBtn.hidden = true;
    const copyBtn = el2("button", "rpCopy", "Copy JSON");
    exportBox.append(sendBtn, copyBtn);
    bar.append(div, stepper, listBtn, moreBtn, wireDot, exportBox);
    root.append(panel, strip, hint, bar);
    document.body.appendChild(root);
    const tip = chrome(el2("div", "rprTip"));
    tip.hidden = true;
    tip.dataset.rpTheme = "light";
    document.body.appendChild(tip);
    function applyTheme() {
      const v = isDark() ? "dark" : "light";
      root.dataset.rpTheme = v;
      tip.dataset.rpTheme = v;
      if (toastNode) toastNode.dataset.rpTheme = v;
      popover.theme(v);
    }
    const dark = matchMedia(DARK);
    const themeWatch = new MutationObserver(applyTheme);
    const watchTheme = (node) => {
      if (node) themeWatch.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    };
    watchTheme(document.documentElement);
    watchTheme(document.body);
    dark.addEventListener("change", applyTheme);
    window.addEventListener("load", applyTheme);
    applyTheme();
    function hideToast() {
      clearTimeout(toastTimer);
      toastNode?.remove();
      toastNode = null;
    }
    function toast(text, undo) {
      hideToast();
      toastNode = chrome(el2("div", "rpToast"));
      toastNode.dataset.rpTheme = root.dataset.rpTheme;
      toastNode.appendChild(document.createTextNode(text));
      const back = el2("button", null, "undo");
      back.addEventListener("click", () => {
        undo?.();
        hideToast();
        render();
      });
      toastNode.appendChild(back);
      document.body.appendChild(toastNode);
      toastTimer = setTimeout(hideToast, 8e3);
    }
    const flashing = /* @__PURE__ */ new Map();
    function flash(node, text) {
      clearTimeout(flashing.get(node)?.timer);
      flashing.set(node, { text, timer: setTimeout(() => {
        flashing.delete(node);
        render();
      }, 1500) });
      render();
    }
    const labelOf = (node, resting) => flashing.has(node) ? flashing.get(node).text : resting;
    function shape(out, which) {
      const copy2 = { ...out };
      if (which === "comments") {
        delete copy2.strokes;
        delete copy2.viewBox;
      }
      if (which === "drawing") {
        return {
          page: copy2.page,
          ...copy2.coords ? { coords: copy2.coords } : {},
          ...copy2.viewBox ? { viewBox: copy2.viewBox } : {},
          ...copy2.targets ? { targets: copy2.targets } : {},
          strokes: copy2.strokes || []
        };
      }
      return copy2;
    }
    const exportObject = (which = "all") => shape(pen.review(), which);
    function copy(which = "all") {
      popover.flush();
      const full = pen.review();
      const text = JSON.stringify(shape(full, which), null, 2);
      const said = which === "drawing" ? `copied \u2713 ${(full.strokes || []).length} strokes` : `copied \u2713 ${full.answered} answers \xB7 ${full.items.filter((i) => i.kind === "comment").length} comments`;
      copyText(text, () => flash(copyBtn, said), () => flash(copyBtn, "copy failed"));
      return text;
    }
    if (clickThrough) {
      clickThroughRule = mark(el2("style"));
      clickThroughRule.id = "rprClickThrough";
      clickThroughRule.textContent = `body:has(.rprBar[data-pointing]) ${clickThrough} { pointer-events: auto !important; }`;
      document.head.appendChild(clickThroughRule);
    }
    function assertClickThrough() {
      if (!clickThrough) return;
      for (const node of document.querySelectorAll(clickThrough)) {
        const r = node.getBoundingClientRect();
        if (!r.width || r.top > innerHeight || r.bottom < 0) continue;
        const x = r.left + r.width / 2, y = Math.max(1, Math.min(innerHeight - 1, r.top + r.height / 2));
        if (!document.elementsFromPoint(x, y).includes(node)) {
          console.warn("[redpen] " + clickThrough + " is still not hit-testable: a drag on it will file an area note, not a region of the picture", node);
        }
        return;
      }
    }
    function setMode(v) {
      if (v) popover.leave();
      pen.setMode(v);
      if (v === "note") assertClickThrough();
      render();
    }
    const toggleMode = (m) => setMode(pen.mode() === m ? null : m);
    function setView(v) {
      view = v;
      confirmAt = null;
      render();
    }
    function runningAt() {
      for (const note of pen.items()) {
        for (const turn of note.thread || []) {
          if (RUNNING.has(turn.state)) return { note, turn };
        }
      }
      return null;
    }
    const openComments = () => pen.items().filter((n) => !n.resolved);
    const resolvedComments = () => pen.items().filter((n) => n.resolved);
    function render() {
      if (!live) return;
      if (current != null) {
        const note = pen.items().find((n) => n.id === current);
        if (!note || note.resolved) current = null;
      }
      const run = runningAt();
      pen.working(run ? run.note.id : null);
      const mode = pen.mode();
      root.classList.toggle("failed", pen.saveFailed());
      if (mode) root.dataset.mode = mode;
      else delete root.dataset.mode;
      root.toggleAttribute("data-pointing", mode === "note");
      commentBtn?.classList.toggle("on", mode === "note");
      drawBtn?.classList.toggle("on", mode === "draw");
      const requests = pen.requests();
      stepper.hidden = !requests.length;
      countText.textContent = labelOf(countText, requests.filter((r) => r.answered).length + "/" + requests.length);
      listN.textContent = String(openComments().length);
      listCar.textContent = view === "list" ? "\u25BE" : "\u25B4";
      listBtn.classList.toggle("on", !!view);
      moreBtn.classList.toggle("on", view === "menu");
      const connected = thread.connected();
      wireDot.hidden = !connected;
      wireDot.classList.toggle("working", thread.busy());
      const p = thread.pending();
      sendBtn.hidden = !connected;
      exportBox.classList.toggle("solid", !connected);
      if (connected) {
        sendBtn.textContent = labelOf(sendBtn, p.count ? "Send " + p.count : "Send");
        sendBtn.disabled = !p.count || !pen.loaded();
        copyBtn.textContent = labelOf(copyBtn, "\u29C9");
        copyBtn.title = "Copy JSON";
      } else {
        copyBtn.textContent = labelOf(copyBtn, "Copy JSON");
        copyBtn.removeAttribute("title");
      }
      renderHint(mode);
      renderStrip(p);
      renderPanel();
    }
    function renderHint(mode) {
      hint.hidden = !mode;
      if (!mode) return;
      hint.textContent = "";
      if (mode === "note") {
        hint.append(document.createTextNode("click or drag an element"), el2("kbd", null, "esc"));
      } else {
        hint.append(
          document.createTextNode("drag to draw"),
          el2("kbd", null, "\u2318Z"),
          document.createTextNode("undo"),
          el2("kbd", null, "esc")
        );
      }
    }
    function renderStrip(p) {
      if (view) {
        strip.hidden = true;
        return;
      }
      const run = runningAt();
      const note = run ? run.note : current == null ? null : pen.items().find((n) => n.id === current && !n.resolved);
      if (!note) {
        strip.hidden = true;
        return;
      }
      strip.hidden = false;
      stripN.textContent = "#" + note.id;
      if (run) {
        stripDot.hidden = false;
        stripDot.className = "rpDot rprDot working";
        stripSaid.className = "rpSaid";
        const trail = run.turn.progress;
        stripSaid.textContent = (trail && trail.length ? trail[trail.length - 1] : turnLine(run.turn)) || "";
        const can = CANCELLABLE.has(run.turn.state) && typeof thread.transport()?.cancel === "function";
        stripAct.hidden = !can;
        stripAct.textContent = "cancel";
        stripAct.onclick = (e) => {
          e.stopPropagation();
          thread.transport().cancel(run.turn.request);
        };
      } else {
        const turns = note.thread || [];
        const last = turns[turns.length - 1] || null;
        const unsent = thread.connected() && (p.comments.includes(note.id) || p.drafts.includes(note.id));
        stripDot.hidden = !last && !unsent;
        stripDot.className = "rpDot rprDot " + (unsent ? "unsent" : last ? dotClass(last.state) : "");
        const empty = !String(note.text || "").trim();
        stripSaid.className = "rpSaid" + (empty ? " dim" : "");
        stripSaid.textContent = (unsent ? "unsent \xB7 " : "") + firstLine(note.text);
        stripAct.hidden = true;
        stripAct.onclick = null;
      }
      strip.onclick = () => openComment(note.id);
    }
    function head(title, rights) {
      const h = el2("div", "rpPhead");
      h.appendChild(document.createTextNode(title));
      h.appendChild(el2("span", "sp"));
      for (const r of rights || []) if (r) h.appendChild(r);
      const x = el2("button", null, "close");
      x.addEventListener("click", () => setView(null));
      h.appendChild(x);
      panel.appendChild(h);
      return h;
    }
    function body(cls) {
      const b = el2("div", "rpPbody" + (cls ? " " + cls : ""));
      panel.appendChild(b);
      return b;
    }
    function headBtn(text, fn) {
      const b = el2("button", null, text);
      b.addEventListener("click", fn);
      return b;
    }
    function renderPanel() {
      if (!view) {
        panel.hidden = true;
        panel.textContent = "";
        return;
      }
      panel.hidden = false;
      panel.textContent = "";
      if (view === "menu") return renderMenu();
      if (view === "resolved") return renderResolved();
      if (view === "orphans") return renderOrphans();
      if (view === "shortcuts") return renderShortcuts();
      renderList();
    }
    function renderList() {
      const list = openComments();
      const retired = resolvedComments().length;
      const orphaned = pen.orphans().length;
      head(list.length + (list.length === 1 ? " comment" : " comments"), [
        retired ? headBtn(retired + " resolved", () => setView("resolved")) : null,
        orphaned ? headBtn(orphaned + " orphaned", () => setView("orphans")) : null
      ]);
      const b = body();
      if (!list.length) {
        b.appendChild(el2("div", "rpEmpty", "No comments yet. Press C, then click anything on the page."));
        return;
      }
      const p = thread.pending();
      for (const note of [...list].reverse()) {
        const row = el2("div", "rpRow");
        const item = el2("button", "rpItem");
        const empty = !String(note.text || "").trim();
        const said = el2("span", "said" + (empty ? " dim" : ""), firstLine(note.text));
        const turns = note.thread || [];
        const running = turns.some((t) => RUNNING.has(t.state));
        const unsent = thread.connected() && (p.comments.includes(note.id) || p.drafts.includes(note.id));
        let mini;
        if (running) mini = "\xB7\xB7\xB7";
        else if (note.unread) mini = "\u25CF reply";
        else if (unsent) mini = "unsent";
        else if (turns.length) mini = turns.length + "\u21A9";
        else mini = elementLabel(note.target, note.kind);
        item.append(el2("span", "n", "#" + note.id), said, el2("span", "mini", mini));
        item.addEventListener("click", () => openComment(note.id));
        const drop = el2("button", "sub danger", "\xD7");
        drop.title = "delete comment " + note.id;
        drop.addEventListener("click", () => removeComment(note.id));
        row.append(item, drop);
        row.addEventListener("mouseenter", () => pen.highlight(note.id));
        row.addEventListener("mouseleave", () => pen.highlight(null));
        b.appendChild(row);
      }
    }
    function renderResolved() {
      const list = resolvedComments();
      head(list.length + " resolved", [headBtn("\u2039 open", () => setView("list"))]);
      const b = body();
      if (!list.length) {
        b.appendChild(el2("div", "rpEmpty", "Nothing retired yet."));
        return;
      }
      for (const note of list) {
        if (confirmAt === "resolved:" + note.id) {
          b.appendChild(confirmRow(`Delete comment ${note.id}?`, () => {
            pen.remove(note.id);
            if (!resolvedComments().length) view = "list";
            setView(view);
          }));
          continue;
        }
        const row = el2("div", "rpRow");
        const item = el2("button", "rpItem");
        item.append(el2("span", "n", "#" + note.id), el2("span", "said dim", firstLine(note.text)));
        item.addEventListener("click", () => {
          thread.resolve(note.id, false);
          setView(null);
          openComment(note.id);
        });
        const back = el2("button", "sub", "reopen");
        back.addEventListener("click", () => {
          thread.resolve(note.id, false);
          setView(null);
          openComment(note.id);
        });
        const drop = el2("button", "sub danger", "discard");
        drop.addEventListener("click", () => {
          confirmAt = "resolved:" + note.id;
          render();
        });
        row.append(item, back, drop);
        b.appendChild(row);
      }
    }
    function renderOrphans() {
      const list = pen.orphans();
      head(list.length + " orphaned", [headBtn("\u2039 open", () => setView("list"))]);
      panel.appendChild(el2("div", "rpNote", "answers to questions the page no longer asks. They still export."));
      const b = body();
      for (const o of list) {
        const row = el2("div", "rpRow");
        const item = el2("button", "rpItem");
        item.append(el2("span", "said dim", o.askedWas || o.key), el2("span", "mini", firstLine(o.answer)));
        const drop = el2("button", "sub danger", "discard");
        drop.addEventListener("click", () => {
          pen.answer(o.key, "");
          if (!pen.orphans().length) view = "list";
          setView(view);
        });
        row.append(item, drop);
        b.appendChild(row);
      }
    }
    function renderShortcuts() {
      head("shortcuts", [headBtn("\u2039 open", () => setView("list"))]);
      const b = body();
      const keysBox = el2("div", "rpKeys");
      for (const [k, said] of SHORTCUTS) {
        const line = el2("div");
        line.append(el2("kbd", null, k), el2("span", null, said));
        keysBox.appendChild(line);
      }
      b.appendChild(keysBox);
    }
    function mi(text, right, fn, danger) {
      const b = el2("button", "mi" + (danger ? " danger" : ""));
      b.appendChild(document.createTextNode(text));
      if (right != null) b.appendChild(el2("span", "k", String(right)));
      b.addEventListener("click", fn);
      return b;
    }
    function confirmRow(text, go) {
      const row = el2("div", "rpConfirm");
      row.append(document.createTextNode(text), el2("span", "sp"));
      const no = el2("button", null, "cancel");
      no.addEventListener("click", () => {
        confirmAt = null;
        render();
      });
      const yes = el2("button", "go", "delete");
      yes.addEventListener("click", () => {
        confirmAt = null;
        go();
      });
      row.append(no, yes);
      return row;
    }
    function renderMenu() {
      head("more");
      if (pen.saveFailed()) {
        panel.appendChild(el2(
          "div",
          "rpWarn",
          "Not saving. These comments only exist in this tab. Copy JSON before you close it."
        ));
      }
      const b = body("rpMenu");
      b.appendChild(mi("Copy JSON", null, () => {
        copy("all");
        setView(null);
      }));
      b.appendChild(mi("Copy comments only", null, () => {
        copy("comments");
        setView(null);
      }));
      b.appendChild(mi("Copy drawing only", null, () => {
        copy("drawing");
        setView(null);
      }));
      if (thread.connected()) {
        b.appendChild(el2("div", "sep"));
        const label = el2("label", "mi");
        const box = el2("input");
        box.type = "checkbox";
        box.checked = !prefs.hold();
        box.addEventListener("change", () => {
          prefs.setHold(!box.checked);
          render();
        });
        label.append(box, document.createTextNode("Send comments as I finish them"));
        b.appendChild(label);
      }
      b.appendChild(el2("div", "sep"));
      b.appendChild(mi("Shortcuts", "?", () => setView("shortcuts")));
      const status = el2("div", "status");
      if (thread.connected()) status.append(el2("span", "rpDot ok"), document.createTextNode("agent connected"));
      else status.append(document.createTextNode("no agent on this page"));
      b.appendChild(status);
      b.appendChild(el2("div", "sep"));
      const comments = pen.items().length;
      const strokes = pen.strokes().length;
      if (confirmAt === "comments") {
        b.appendChild(confirmRow(`Delete ${comments} comment${comments === 1 ? "" : "s"}?`, () => pen.clearNotes()));
      } else {
        const row = mi("Clear all comments\u2026", comments, () => {
          confirmAt = "comments";
          render();
        }, true);
        row.disabled = !comments;
        b.appendChild(row);
      }
      if (confirmAt === "ink") {
        b.appendChild(confirmRow(`Delete ${strokes} stroke${strokes === 1 ? "" : "s"}?`, () => pen.clearStrokes()));
      } else {
        const row = mi("Clear all ink\u2026", strokes, () => {
          confirmAt = "ink";
          render();
        }, true);
        row.disabled = !strokes;
        b.appendChild(row);
      }
    }
    function openComment(id) {
      const note = pen.items().find((n) => n.id === id);
      if (!note) return;
      current = id;
      setView(null);
      popover.openComment(note);
    }
    function removeComment(id) {
      const note = pen.items().find((n) => n.id === id);
      if (!note) return;
      popover.closeIf(id);
      pen.remove(id);
      render();
      toast(`comment ${id} deleted`, () => pen.restore([note]));
    }
    function hideTip() {
      if (!tip.hidden) tip.hidden = true;
    }
    function showTip(node) {
      const text = node.dataset.tooltip ? "" : node.getAttribute(attr);
      if (!text) return hideTip();
      tip.textContent = text;
      tip.hidden = false;
      const r = node.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const above = r.top - t.height - 8;
      tip.style.left = Math.max(8, Math.min(r.left, innerWidth - t.width - 8)) + "px";
      tip.style.top = (above < 8 ? r.bottom + 8 : above) + "px";
    }
    function showPeek(node, text) {
      tip.textContent = text;
      tip.hidden = false;
      const r = node.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      let left = r.right + 8;
      if (left + t.width > innerWidth - 8) left = Math.max(8, r.left - t.width - 8);
      tip.style.left = left + "px";
      tip.style.top = Math.max(8, Math.min(r.top, innerHeight - t.height - 8)) + "px";
    }
    const onHover = (e) => {
      if (e.target && e.target.closest && e.target.closest(".laMarkers")) return;
      const node = e.target && e.target.closest ? e.target.closest("[" + attr + "]") : null;
      node ? showTip(node) : hideTip();
    };
    const onMarkerHover = (e) => {
      const hit = e.target && e.target.closest ? e.target.closest("[data-la-note]") : null;
      if (!hit) return hideTip();
      const note = pen.items().find((n) => n.id === Number(hit.dataset.laNote));
      if (!note) return hideTip();
      showPeek(hit, markerTitle(note));
    };
    document.addEventListener("mouseover", onHover);
    document.addEventListener("focusin", onHover);
    window.addEventListener("scroll", hideTip, true);
    const markerLayer = (mountNode || document).querySelector(".laMarkers");
    markerLayer?.addEventListener("mouseover", onMarkerHover);
    markerLayer?.addEventListener("mouseout", hideTip);
    function onKey(e) {
      if (!active()) return;
      const typing = isTyping(e.target) || isTyping(document.activeElement);
      if (e.key === "Escape") {
        if (view) return setView(null);
        if (popover.isOpen()) return popover.cancel();
        if (pen.mode()) return setMode(null);
        return;
      }
      if (typing) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && popover.isOpen()) {
          e.preventDefault();
          popover.finish();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && pen.mode() === "draw") {
          e.preventDefault();
          pen.undoStroke();
        }
        return;
      }
      if (e.key === "c" && tools.has("comment")) return toggleMode("note");
      if (e.key === "d" && tools.has("draw")) return toggleMode("draw");
      if (e.key === "n" && pen.requests().length) return step(1);
      if (e.key === "?") return setView(view === "shortcuts" ? null : "shortcuts");
    }
    if (keys) window.addEventListener("keydown", onKey);
    function onPointerDown(e) {
      if (view && !e.target.closest(".rpDock")) setView(null);
      if (!popover.isOpen()) return;
      if (e.target.closest("[data-la-ui]")) return;
      if (e.target.closest(INTERACTIVE)) return;
      popover.leave();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    commentBtn?.addEventListener("click", () => toggleMode("note"));
    drawBtn?.addEventListener("click", () => toggleMode("draw"));
    prevBtn.addEventListener("click", () => step(-1));
    nextBtn.addEventListener("click", () => step(1));
    listBtn.addEventListener("click", () => setView(view === "list" ? null : "list"));
    moreBtn.addEventListener("click", () => setView(view === "menu" ? null : "menu"));
    copyBtn.addEventListener("click", () => copy("all"));
    sendBtn.addEventListener("click", () => {
      popover.leave();
      const want = thread.pending().count;
      const started = thread.sendPending();
      if (!started && want) flash(sendBtn, "not sent, copy instead");
      render();
    });
    wireDot.addEventListener("click", () => {
      const run = runningAt();
      if (run) return openComment(run.note.id);
      setView(view === "list" ? null : "list");
    });
    pen.addEventListener("mode", render);
    pen.addEventListener("change", (e) => {
      const d = e.detail || {};
      if (d.action === "note" && d.item) current = d.item.id;
      if (d.action === "add" && d.item) current = d.item.id;
      if (d.action === "load") {
        const open = openComments();
        current = open.length ? open[open.length - 1].id : null;
      }
    });
    pen.addEventListener("item:add", (e) => {
      if (!e.detail.sticky) pen.setMode(null);
      current = e.detail.item.id;
      popover.openComment(e.detail.item, { fresh: true });
      render();
    });
    pen.addEventListener("item:click", (e) => {
      current = e.detail.item.id;
      popover.openComment(e.detail.item);
      render();
    });
    pen.addEventListener("request:click", (e) => popover.openAsk(e.detail.request.key));
    root.classList.add("rpTeach");
    const teachTimer = setTimeout(() => root.classList.remove("rpTeach"), 8e3);
    return {
      node: root,
      render,
      setMode,
      setView,
      toast,
      copy,
      exportObject,
      flashCount: (text) => flash(countText, text),
      destroy() {
        live = false;
        clearTimeout(teachTimer);
        for (const { timer } of flashing.values()) clearTimeout(timer);
        flashing.clear();
        hideToast();
        if (keys) window.removeEventListener("keydown", onKey);
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("mouseover", onHover);
        document.removeEventListener("focusin", onHover);
        window.removeEventListener("scroll", hideTip, true);
        window.removeEventListener("load", applyTheme);
        dark.removeEventListener("change", applyTheme);
        themeWatch.disconnect();
        markerLayer?.removeEventListener("mouseover", onMarkerHover);
        markerLayer?.removeEventListener("mouseout", hideTip);
        clickThroughRule?.remove();
        clickThroughRule = null;
        root.remove();
        tip.remove();
      }
    };
  }

  // src/wire.js
  var attached = null;
  var RUNNING2 = /* @__PURE__ */ new Set(["sent", "acked", "landing"]);
  function nearestKey(el3) {
    for (let node = el3; node && node.nodeType === 1; node = node.parentElement) {
      const dataId = node.getAttribute("data-id");
      const id = node.getAttribute("id");
      if (dataId) return { key: dataId, selector: `[data-id="${CSS.escape(dataId)}"]`, tag: node.tagName.toLowerCase() };
      if (id) return { key: id, selector: `#${CSS.escape(id)}`, tag: node.tagName.toLowerCase() };
    }
    return null;
  }
  function decode(line) {
    const raw = String(line ?? "");
    if (raw.trimStart()[0] !== "{") return { kind: "progress", text: raw };
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      if (/"redpen"\s*:/.test(raw)) return { kind: "mangled", text: raw };
      return { kind: "progress", text: raw };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "progress", text: raw };
    if (!Object.prototype.hasOwnProperty.call(parsed, "redpen")) return { kind: "progress", text: raw };
    if (typeof parsed.reply !== "string" || !parsed.reply) return { kind: "broken", text: raw };
    return { kind: "reply", text: parsed.reply, append: parsed.append === true };
  }
  function payloadFor(request) {
    const item = request.item || null;
    const projection = request.projection || {};
    const history = request.history || null;
    const { thread, ...bare } = item || {};
    const selector = item && item.anchor && item.anchor.selector;
    const el3 = selector ? document.querySelector(selector) : null;
    return {
      kind: "comment",
      page: projection.page,
      said: request.ask,
      ...request.turn > 1 ? { turn: request.turn } : {},
      ...history ? {
        thread: history.pairs,
        ...history.earlier ? { earlier: history.earlier } : {}
      } : {},
      item: item ? bare : null,
      // The coordinate rule travels with the item, because the item's geometry is
      // expressed in that rule and reads as fractions of the wrong box without it.
      ...item && item.target_id ? { target: (projection.targets || {})[item.target_id] || null } : projection.coords ? { coords: projection.coords } : {},
      ...el3 ? { region: nearestKey(el3) } : {}
    };
  }
  function createTransport(wire) {
    let sink = null;
    let off = null;
    const mine = /* @__PURE__ */ new Set();
    function onFrame(rec, frame) {
      if (!sink || !mine.has(rec.id)) return;
      if (RUNNING2.has(rec.state)) sink.state(rec.id, rec.state);
      const line = frame && typeof frame.text === "string" ? frame.text : rec.state === "acked" && rec.text ? rec.text : "";
      if (!line) return;
      const said = decode(line);
      if (said.kind === "reply") return void sink.reply(rec.id, said.text, { append: said.append });
      if (said.kind === "mangled") {
        sink.progress(rec.id, said.text);
        return void sink.note(rec.id, "the agent sent a reply that did not survive the trip");
      }
      if (said.kind === "broken") {
        sink.progress(rec.id, said.text);
        return void sink.note(rec.id, "the agent marked a reply that carried no words");
      }
      sink.progress(rec.id, said.text);
    }
    return {
      label: "agent",
      attach(s) {
        sink = s;
        off = wire.on(onFrame);
      },
      detach() {
        off?.();
        off = null;
        sink = null;
        mine.clear();
        if (attached && attached.transport === this) attached = null;
      },
      // redpen mints the id, because clayjs emits the first frame from inside
      // send(): a mapping built from the return value would be built too late to
      // route it.
      send(request) {
        const handle = wire.send(payloadFor(request), { id: request.id, text: request.ask });
        if (!handle || !handle.id) return null;
        mine.add(handle.id);
        handle.done.then(
          (final) => {
            mine.delete(handle.id);
            sink?.state(handle.id, final.state, final.error);
          },
          (err) => {
            mine.delete(handle.id);
            sink?.state(handle.id, "error", err && err.message ? err.message : "the wire failed");
          }
        );
        return { id: handle.id };
      },
      // clayjs refuses a cancel that arrived too late, so the rule lives there
      // rather than being restated here where the two could quietly disagree.
      cancel: (id) => wire.cancel(id)
    };
  }
  function attach(review, opts = {}) {
    const wire = window.clay && window.clay.wire;
    if (!wire || typeof wire.send !== "function" || typeof wire.on !== "function") {
      console.warn("[redpen] no clay.wire on this page: comments stay in the clipboard");
      return null;
    }
    if (attached) {
      if (attached.review !== review) console.warn("[redpen] the wire is already attached to this page");
      return attached;
    }
    if (review.thread && review.thread.connected && review.thread.connected()) {
      console.warn("[redpen] a transport is already connected to this review");
      return null;
    }
    const transport = opts.transport || createTransport(wire);
    const disconnect = review.thread.connect(transport);
    attached = {
      review,
      transport,
      send: (request) => transport.send(request),
      detach() {
        disconnect();
        attached = null;
      }
    };
    return attached;
  }

  // src/mount.js
  function mount(opts = {}) {
    const key = opts.key ?? location.pathname;
    const attr = opts.attr || "data-review-ask";
    const tools = new Set(opts.tools || ["comment", "draw"]);
    const mountNode = opts.mount ?? document.body;
    const backend = opts.backend ?? (findPageBlock() ? createPageBackend() : void 0);
    const pen = create({ key, mount: mountNode, backend });
    let visible = !opts.hidden;
    const hideRule = mark(document.createElement("style"));
    hideRule.textContent = "[data-la-ui]{display:none!important}";
    const applyVisibility = () => visible ? hideRule.remove() : document.head.appendChild(hideRule);
    applyVisibility();
    const listeners = /* @__PURE__ */ new Set();
    if (typeof opts.onComment === "function") listeners.add(opts.onComment);
    const holdKey = "redpen:hold:" + key;
    const prefs = {
      hold: () => {
        try {
          return localStorage.getItem(holdKey) === "1";
        } catch {
          return false;
        }
      },
      setHold: (v) => {
        try {
          v ? localStorage.setItem(holdKey, "1") : localStorage.removeItem(holdKey);
        } catch {
        }
      }
    };
    let live = true;
    const thread = createThread({ pen, listeners, prefs, onTurn });
    const popover = createPopover({
      pen,
      thread,
      prefs,
      toast: (text, undo) => dock.toast(text, undo),
      onChange: () => dock.render(),
      anchor: () => dock.node,
      step
    });
    const dock = createDock({
      pen,
      thread,
      popover,
      prefs,
      tools,
      attr,
      mountNode,
      step,
      clickThrough: opts.clickThrough || "",
      keys: opts.keys !== false,
      active: () => visible
    });
    thread.setOpener((id) => {
      const note = pen.items().find((n) => n.id === id);
      if (note) popover.openComment(note);
    });
    function onTurn(noteId, turnId) {
      if (!live) return;
      dock.render();
      popover.onTurn(noteId, turnId);
    }
    function scan() {
      const list = [];
      const seen = /* @__PURE__ */ new Set();
      for (const node of document.querySelectorAll("[" + attr + "]")) {
        const ask = node.getAttribute(attr);
        if (!node.id) {
          console.warn("[redpen] skipped a question with no id: the id is the answer's key", node);
          continue;
        }
        if (seen.has(node.id)) {
          console.warn("[redpen] skipped a duplicate question id: " + node.id, node);
          continue;
        }
        seen.add(node.id);
        list.push({ key: node.id, ask, el: node });
      }
      pen.setRequests(list);
      return list.length;
    }
    function step(dir) {
      popover.flush();
      const list = pen.requests();
      if (!list.length) return;
      const at = popover.openAt();
      const i = at && at.kind === "ask" ? list.findIndex((r) => r.key === at.key) : -1;
      const from = i < 0 ? dir > 0 ? -1 : 0 : i;
      for (let n = 1; n <= list.length; n++) {
        const r = list[((from + dir * n) % list.length + list.length) % list.length];
        if (dir < 0 || !r.answered) return popover.openAsk(r.key);
      }
      popover.leave();
      dock.flashCount("all answered");
    }
    function refresh() {
      popover.leave();
      scan();
      dock.render();
    }
    scan();
    dock.render();
    pen.addEventListener("change", (e) => {
      if (!live) return;
      dock.render();
      if (e.detail.action === "load") {
        thread.sweepUnfinished();
        popover.reseed();
      }
    });
    pen.addEventListener("save:error", () => dock.render());
    pen.addEventListener("layout", popover.relayout);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (live) pen.layout();
      });
    }
    function show() {
      if (visible) return;
      visible = true;
      applyVisibility();
      if (tools.has("comment")) dock.setMode("note");
    }
    function hide() {
      if (!visible) return;
      popover.leave();
      dock.setView(null);
      dock.setMode(null);
      visible = false;
      applyVisibility();
    }
    const sequence = opts.toggle === void 0 ? ";;" : opts.toggle;
    const editable = (n) => !!n && n.nodeType === 1 && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName));
    let typed = "";
    let typedAt = 0;
    function onToggleKey(e) {
      if (!sequence || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
      if (editable(e.target) || editable(document.activeElement)) {
        typed = "";
        return;
      }
      typed = (e.timeStamp - typedAt > 600 ? "" : typed) + e.key;
      typedAt = e.timeStamp;
      if (!sequence.startsWith(typed)) typed = sequence.startsWith(e.key) ? e.key : "";
      if (typed !== sequence) return;
      typed = "";
      e.preventDefault();
      visible ? hide() : show();
    }
    if (opts.keys !== false) window.addEventListener("keydown", onToggleKey);
    const adapter = {
      pen,
      refresh,
      open: popover.openAsk,
      next: () => step(1),
      prev: () => step(-1),
      point: (on) => dock.setMode(on ? "note" : null),
      mode(v) {
        if (v === void 0) return pen.mode();
        dock.setMode(v || null);
        return pen.mode();
      },
      copy: (which) => dock.copy(which),
      json: () => dock.exportObject("all"),
      send: () => thread.sendPending(),
      thread,
      show,
      hide,
      toggle: () => visible ? hide() : show(),
      get visible() {
        return visible;
      },
      // Registered after the fact so a transport can be a separate bundle that
      // attaches to this object, rather than something mount() has to be told
      // about before it runs. Returns its own unsubscribe: a caller may only ever
      // remove the listener it added.
      onComment(fn) {
        if (typeof fn !== "function") return () => {
        };
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      destroy() {
        live = false;
        popover.leave();
        thread.disconnect(true);
        dock.destroy();
        popover.destroy();
        pen.destroy();
        window.removeEventListener("keydown", onToggleKey);
        hideRule.remove();
      }
    };
    function attachWire(wire) {
      if (wire && typeof wire.send === "function") {
        thread.connect(wire);
        dock.render();
        return;
      }
      const go = () => {
        if (live) attach(adapter);
      };
      const ready = window.clay && window.clay.ready;
      if (ready && typeof ready.then === "function") ready.then(go, go);
      else go();
    }
    if (opts.wire !== false) attachWire(opts.wire);
    return adapter;
  }

  // src/index-review.js
  if (!window.RedpenReview) window.RedpenReview = { mount: (o = {}) => mount({ key: "review:" + location.pathname, ...o }) };
  if (!window.RedpenWire) window.RedpenWire = { attach };
})();
