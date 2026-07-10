(() => {
  // src/feedback-hub.js
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
  function json() {
    const out = { file: location.pathname.split("/").pop() || location.pathname };
    for (const t of tools) if (t.checked) out[t.id] = t.getData();
    return JSON.stringify(out, null, 2);
  }
  function off() {
    for (const t of tools) if (t.getOn()) {
      t.setOn(false);
      syncPill(t);
    }
  }
  if (!window.FeedbackHub) window.FeedbackHub = { register, json, off, tools };

  // src/notes.js
  if (!window.NotesTool) {
    let save = function() {
      localStorage.setItem(STORE, JSON.stringify({ v: 2, counter, items }));
    }, topElementAt = function(x, y) {
      for (const el of document.elementsFromPoint(x, y)) {
        if (el.closest("[data-la-ui]")) continue;
        return el;
      }
      return document.body;
    }, graphicBasis = function(el) {
      for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
        const t = n.tagName.toLowerCase();
        if (t === "canvas" || t === "img" || t === "video") return n;
        if (t === "svg" && !n.ownerSVGElement) return n;
      }
      return null;
    }, nthOfType = function(el) {
      const p = el.parentElement;
      if (!p) return 0;
      const sibs = [...p.children].filter((s) => s.tagName === el.tagName);
      return sibs.length > 1 ? sibs.indexOf(el) + 1 : 0;
    }, cssPath = function(el) {
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
    }, describe = function(el, lite) {
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
    }, resolve = function(target) {
      try {
        return document.querySelector(target.selector);
      } catch {
        return null;
      }
    }, renderRows = function() {
      list.innerHTML = "";
      rowEls.clear();
      for (const it of items) {
        const row = document.createElement("div");
        row.className = "laNoteRow";
        row.title = it.target.selector;
        const num = document.createElement("span");
        num.className = "num";
        num.textContent = it.id;
        const input = document.createElement("input");
        input.value = it.note;
        input.placeholder = "what's wrong here";
        input.addEventListener("input", () => {
          it.note = input.value;
          save();
        });
        const del = document.createElement("button");
        del.textContent = "\xD7";
        del.title = "delete";
        del.addEventListener("click", () => {
          items = items.filter((x) => x !== it);
          save();
          renderRows();
          layout();
        });
        row.append(num, input, del);
        list.appendChild(row);
        rowEls.set(it, row);
      }
    }, place = function(el, r) {
      const base = markers.getBoundingClientRect();
      el.style.left = r.left - base.left + "px";
      el.style.top = r.top - base.top + "px";
      el.style.width = r.width + "px";
      el.style.height = r.height + "px";
    }, layout = function() {
      markers.querySelectorAll(".laBox").forEach((el) => {
        if (el !== rubber) el.remove();
      });
      for (const it of items) {
        const el = resolve(it.target);
        rowEls.get(it)?.classList.toggle("stale", !el);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const box = document.createElement("div");
        box.className = "laBox" + (it.type === "element" ? " el" : "");
        box.innerHTML = `<span class="tag">${it.id}</span>`;
        if (it.region) {
          place(box, {
            left: r.left + it.region.x * r.width,
            top: r.top + it.region.y * r.height,
            width: it.region.w * r.width,
            height: it.region.h * r.height
          });
        } else {
          place(box, r);
        }
        markers.appendChild(box);
      }
    }, setHover = function(r) {
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
    }, clampedRegion = function(e) {
      const b = press.basis.getBoundingClientRect();
      const cx = Math.max(b.left, Math.min(e.clientX, b.right));
      const cy = Math.max(b.top, Math.min(e.clientY, b.bottom));
      const px = Math.max(b.left, Math.min(press.x, b.right));
      const py = Math.max(b.top, Math.min(press.y, b.bottom));
      return { b, left: Math.min(px, cx), top: Math.min(py, cy), width: Math.abs(cx - px), height: Math.abs(cy - py) };
    }, freeRect = function(e) {
      return {
        left: Math.min(press.x, e.clientX),
        top: Math.min(press.y, e.clientY),
        width: Math.abs(e.clientX - press.x),
        height: Math.abs(e.clientY - press.y)
      };
    }, escapeCheck = function(e) {
      if (!press.basis || press.area) return;
      const b = press.basis.getBoundingClientRect();
      if (e.clientX < b.left - 8 || e.clientX > b.right + 8 || e.clientY < b.top - 8 || e.clientY > b.bottom + 8) {
        press.area = true;
      }
    }, dragMove = function(e) {
      if (!rubber) {
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
        rubber = document.createElement("div");
        rubber.className = "laBox";
        markers.appendChild(rubber);
      }
      escapeCheck(e);
      place(rubber, press.basis && !press.area ? clampedRegion(e) : freeRect(e));
    }, elementsInArea = function(rect) {
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
    }, commonAncestor = function(els) {
      let anc = els[0];
      for (const el of els.slice(1)) {
        while (!anc.contains(el)) anc = anc.parentElement;
      }
      return anc;
    }, inFixed = function(el) {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === "fixed") return true;
      }
      return false;
    }, addAreaItem = function(r) {
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
      addItem({
        type: "area",
        target: describe(anchor),
        rect: { w: Math.round(b.width), h: Math.round(b.height) },
        region: {
          x: round3((r.left - b.left) / b.width),
          y: round3((r.top - b.top) / b.height),
          w: round3(r.width / b.width),
          h: round3(r.height / b.height)
        },
        elements: listed.map((el) => {
          const d = describe(el, true);
          if (fixed.has(el)) d.fixed = true;
          return d;
        }),
        ...truncated ? { truncated } : {}
      });
    }, addItem = function(fields) {
      const it = { id: ++counter, note: "", ...fields };
      items.push(it);
      save();
      renderRows();
      layout();
      rowEls.get(it)?.querySelector("input").focus();
    }, setOn = function(v) {
      on = v;
      overlay.style.display = v ? "block" : "none";
      if (!v) {
        setHover(null);
        rubber?.remove();
        rubber = null;
        press = null;
      }
      layout();
    }, clearAll = function() {
      items = [];
      counter = 0;
      save();
      renderRows();
      layout();
    }, getData = function() {
      return {
        coords: "region = fractions of the target element box, usually 0-1, beyond that when the drag exceeded the box; area items also list the elements selected inside",
        items: items.map((it) => ({
          id: it.id,
          note: it.note,
          type: it.type,
          target: it.target,
          ...it.region ? { rect: it.rect, region: it.region } : {},
          ...it.elements ? { elements: it.elements } : {},
          ...it.truncated ? { truncated: it.truncated } : {}
        }))
      };
    };
    const STORE = "la-notes:" + location.pathname;
    const round3 = (n) => Math.round(n * 1e3) / 1e3;
    let items = [], counter = 0, on = false;
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || "{}");
      if (saved.v === 2) {
        items = saved.items || [];
        counter = saved.counter || 0;
      } else if (saved.annos) {
        items = saved.annos.map((a) => ({
          id: a.id,
          note: a.note,
          type: "region",
          target: { selector: "#gl", tag: "canvas" },
          rect: { w: 560, h: 373 },
          region: { x: a.x, y: a.y, w: a.w, h: a.h }
        }));
        counter = saved.counter || items.length;
      }
    } catch {
    }
    const style = document.createElement("style");
    style.textContent = `
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
  #laMarkers { position: absolute; left: 0; top: 0; width: 0; height: 0; overflow: visible; z-index: 99991; pointer-events: none; }
  .laBox { position: absolute; border: 2px solid #e5484d; background: rgba(229, 72, 77, .12); box-sizing: border-box; }
  .laBox.el { background: rgba(229, 72, 77, .06); }
  .laBox .tag { position: absolute; top: -10px; left: -10px; background: #e5484d; color: #fff;
    font: 700 11px/16px -apple-system, sans-serif; text-align: center; min-width: 16px; height: 16px; border-radius: 8px; padding: 0 3px; }
  .laHover { position: absolute; border: 1.5px dashed #e5484d; background: rgba(229, 72, 77, .07); box-sizing: border-box; }
  #laOverlay { position: fixed; inset: 0; z-index: 99992; display: none; touch-action: none; }
`;
    document.head.appendChild(style);
    const panel = document.createElement("aside");
    panel.id = "laNotes";
    panel.dataset.laUi = "1";
    panel.setAttribute("sap-ignore", "");
    panel.innerHTML = `<h2>Notes</h2>
  <p class="hint">Toggle NOTES, then click an element or drag a box across an area. COPY JSON sends it all back.</p>
  <div id="laNoteList"></div>`;
    document.body.appendChild(panel);
    const list = panel.querySelector("#laNoteList");
    const markers = document.createElement("div");
    markers.id = "laMarkers";
    markers.dataset.laUi = "1";
    markers.setAttribute("sap-ignore", "");
    document.body.appendChild(markers);
    const overlay = document.createElement("div");
    overlay.id = "laOverlay";
    overlay.dataset.laUi = "1";
    overlay.setAttribute("sap-ignore", "");
    document.body.appendChild(overlay);
    const rowEls = /* @__PURE__ */ new Map();
    let hover = null;
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
      press = { x: e.clientX, y: e.clientY, el, basis: graphicBasis(el), area: false };
      setHover(null);
    });
    overlay.addEventListener("pointerup", (e) => {
      if (!press) return;
      if (rubber) {
        escapeCheck(e);
        rubber.remove();
        rubber = null;
        const graphic = press.basis && !press.area;
        const r = graphic ? clampedRegion(e) : freeRect(e);
        if (r.width <= 6 && r.height <= 6) {
          addItem({ type: "element", target: describe(press.el) });
        } else if (graphic) {
          addItem({
            type: "region",
            target: describe(press.basis),
            rect: { w: Math.round(r.b.width), h: Math.round(r.b.height) },
            region: {
              x: round3((r.left - r.b.left) / r.b.width),
              y: round3((r.top - r.b.top) / r.b.height),
              w: round3(r.width / r.b.width),
              h: round3(r.height / r.b.height)
            }
          });
        } else {
          addAreaItem(r);
        }
      } else {
        addItem({ type: "element", target: describe(press.el) });
      }
      press = null;
    });
    overlay.addEventListener("pointercancel", () => {
      rubber?.remove();
      rubber = null;
      press = null;
    });
    const MAX_AREA_ELEMENTS = 15;
    const handle = register({ id: "notes", label: "NOTES", getOn: () => on, setOn, clear: clearAll, getData });
    window.addEventListener("resize", layout);
    renderRows();
    let tries = 0;
    (function settle() {
      layout();
      if (tries++ < 20 && items.some((it) => !resolve(it.target))) setTimeout(settle, 500);
    })();
    window.NotesTool = {
      on: (v) => handle.setOn(v),
      clear: clearAll,
      layout,
      items: () => items
    };
  }

  // src/draw.js
  if (!window.DrawTool) {
    let origin = function() {
      const f = document.getElementById("frame");
      if (!f) return { x: -scrollX, y: -scrollY };
      const r = f.getBoundingClientRect();
      return { x: r.left, y: r.top };
    }, saveStrokes = function() {
      const r1 = (n) => Math.round(n * 10) / 10;
      localStorage.setItem(STORE, JSON.stringify(strokes.map((s) => s.map((p) => [r1(p.x), r1(p.y)]))));
    }, resize = function() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      canvas.style.width = innerWidth + "px";
      canvas.style.height = innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }, follow = function(x, y) {
      const dx = x - brush.x, dy = y - brush.y;
      const d = Math.hypot(dx, dy);
      if (d <= CFG.lazyRadius) return;
      const k = (d - CFG.lazyRadius) / d;
      brush.x += dx * k;
      brush.y += dy * k;
      live.push({ x: brush.x, y: brush.y });
    }, finishStroke = function() {
      if (!live) return;
      strokes.push(live.length > 1 ? smooth(live) : live);
      live = null;
      saveStrokes();
      redraw();
    }, resample = function(pts, step) {
      const out = [pts[0]];
      let prev = pts[0], carry = 0;
      for (let i = 1; i < pts.length; i++) {
        const cur = pts[i];
        let d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
        while (carry + d >= step) {
          const t = (step - carry) / d;
          const p = { x: prev.x + (cur.x - prev.x) * t, y: prev.y + (cur.y - prev.y) * t };
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
    }, boxFilter = function(pts, win) {
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
    }, smooth = function(pts) {
      let p = resample(pts, CFG.resampleStep);
      for (let k = 0; k < CFG.smoothPasses; k++) p = boxFilter(p, CFG.smoothWindow);
      return p;
    }, drawStroke = function(pts) {
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
    }, redraw = function() {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const o = origin();
      ctx.save();
      ctx.translate(o.x, o.y);
      for (const s of strokes) drawStroke(s);
      if (live) drawStroke(live);
      ctx.restore();
    }, clearAll = function() {
      strokes.length = 0;
      saveStrokes();
      redraw();
    }, setOn = function(v) {
      on = v;
      canvas.style.pointerEvents = v ? "auto" : "none";
    }, getData = function() {
      const f = document.getElementById("frame");
      const r3 = (n) => Math.round(n * 1e3) / 1e3;
      if (f) {
        const r = f.getBoundingClientRect();
        return {
          coords: "fractions 0-1 of the illustration frame",
          frame: { w: Math.round(r.width), h: Math.round(r.height) },
          strokes: strokes.map((s) => s.map((p) => [r3(p.x / r.width), r3(p.y / r.height)]))
        };
      }
      const r1 = (n) => Math.round(n * 10) / 10;
      return { coords: "px from document top-left", strokes: strokes.map((s) => s.map((p) => [r1(p.x), r1(p.y)])) };
    };
    const CFG = {
      width: 3,
      // stroke width, px
      color: "#000",
      lazyRadius: 4,
      // brush trails the pointer by this many px; the live jitter killer
      resampleStep: 3,
      // finished stroke gets one point per N px of arc length
      smoothWindow: 4,
      // box-filter half-width (points each side) on the finished stroke
      smoothPasses: 2
      // box-filter iterations
    };
    const canvas = document.createElement("canvas");
    canvas.dataset.laUi = "1";
    canvas.setAttribute("sap-ignore", "");
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      zIndex: 99990,
      pointerEvents: "none",
      cursor: "crosshair",
      touchAction: "none"
    });
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    const STORE = "la-draw:" + location.pathname;
    const strokes = [];
    try {
      for (const s of JSON.parse(localStorage.getItem(STORE) || "[]")) {
        strokes.push(s.map(([x, y]) => ({ x, y })));
      }
    } catch {
    }
    let live = null;
    let brush = null;
    let on = false;
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", () => redraw(), { passive: true });
    canvas.addEventListener("pointerdown", (e) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
      }
      const o = origin();
      brush = { x: e.clientX - o.x, y: e.clientY - o.y };
      live = [{ ...brush }];
      redraw();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!live) return;
      let events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (events.length === 0) events = [e];
      const o = origin();
      for (const ev of events) follow(ev.clientX - o.x, ev.clientY - o.y);
      redraw();
    });
    canvas.addEventListener("pointerup", finishStroke);
    canvas.addEventListener("pointercancel", finishStroke);
    window.addEventListener("keydown", (e) => {
      if (!on) return;
      if (e.target.closest && e.target.closest("input, textarea")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "z") {
        e.preventDefault();
        strokes.pop();
        saveStrokes();
        redraw();
      }
    });
    setOn(false);
    resize();
    const handle = register({ id: "draw", label: "DRAW", labelOn: "DRAWING", getOn: () => on, setOn, clear: clearAll, getData });
    window.DrawTool = {
      cfg: CFG,
      tune: (o) => Object.assign(CFG, o),
      on: (v) => handle.setOn(v),
      undo: () => {
        strokes.pop();
        saveStrokes();
        redraw();
      },
      clear: clearAll,
      strokes
    };
  }
})();
