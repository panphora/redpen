// draw-surface.js — freehand ink. A sketch canvas over `mount`; strokes are 3px
// black ink, jitter-smoothed. Smoothing adapts to pointer speed: slow, deliberate
// drawing is only lightly smoothed, fast strokes get the full filter. Strokes are
// anchored to the illustration #frame when one exists, else to the document, so
// they stay glued to content while scrolling.
//
// Injects only the canvas. No bar, no keyboard: the host routes undo.

import { chrome } from './mark.js';

export const CFG = {
  width: 3,           // stroke width, px
  color: '#000',
  lazyRadius: 4,      // brush trails the pointer by this many px at full speed; the live jitter killer
  minLazyRadius: 1.5, // brush trail when the pointer is moving slowly
  resampleStep: 3,    // finished stroke gets one point per N px of arc length
  smoothWindow: 4,    // box-filter half-width (points each side) on the finished stroke
  smoothPasses: 2,    // box-filter iterations
  slowSpeed: 0.15,    // px/ms — at or below this, smoothing stays at slowBlend
  fastSpeed: 1,       // px/ms — at or above this, smoothing applies in full
  slowBlend: 0.3,     // fraction of the full smoothing kept for slow, deliberate strokes
  simplifyTol: 1,     // export-time RDP tolerance, px; points stay untouched internally
};

// 0 at slowSpeed and below, 1 at fastSpeed and above
export function speedT(v) {
  return Math.max(0, Math.min(1, (v - CFG.slowSpeed) / (CFG.fastSpeed - CFG.slowSpeed)));
}

// ---------- post-stroke smoothing ----------
// Resample to even spacing (raw pointer points bunch up when the hand slows,
// which would bias any filter), then box-filter with pinned endpoints. The
// filtered stroke is blended back toward the resampled original by pointer
// speed: fast segments keep the full correction, slow deliberate segments
// keep only slowBlend of it.

export function resample(pts, step) {
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
        v: prev.v + (cur.v - prev.v) * t,
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

export function boxFilter(pts, win) {
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { ...p };
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(pts.length - 1, i + win); j++) {
      sx += pts[j].x; sy += pts[j].y; n++;
    }
    return { x: sx / n, y: sy / n };
  });
}

export function smooth(pts) {
  const p = resample(pts, CFG.resampleStep);
  let s = p;
  for (let k = 0; k < CFG.smoothPasses; k++) s = boxFilter(s, CFG.smoothWindow);
  return p.map((q, i) => {
    const a = CFG.slowBlend + (1 - CFG.slowBlend) * speedT(q.v);
    return { x: q.x + (s[i].x - q.x) * a, y: q.y + (s[i].y - q.y) * a, v: q.v };
  });
}

// ---------- export projection ----------
// Points are the internal model; the SVG path is a projection computed here.
// Each stroke: RDP-simplify, then emit an absolute-integer M/L path (Z when
// the stroke closes on itself) plus its bbox.

export function simplify(pts, eps) {
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
      const d = len === 0
        ? Math.hypot(pts[i].x - ax, pts[i].y - ay)
        : Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
      if (d > max) { max = d; idx = i; }
    }
    if (max > eps) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

export function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  x0 = Math.round(x0); y0 = Math.round(y0);
  return [x0, y0, Math.round(x1) - x0, Math.round(y1) - y0];
}

export function isClosed(pts, bbox) {
  if (pts.length < 3) return false;
  const a = pts[0], b = pts[pts.length - 1];
  const diag = Math.hypot(bbox[2], bbox[3]);
  return Math.hypot(b.x - a.x, b.y - a.y) <= Math.max(2 * CFG.width, 0.15 * diag);
}

export function toPath(pts, closed) {
  let px = Math.round(pts[0].x), py = Math.round(pts[0].y);
  let d = `M ${px} ${py}`;
  for (let i = 1; i < pts.length; i++) {
    const x = Math.round(pts[i].x), y = Math.round(pts[i].y);
    if (x === px && y === py) continue;
    d += ` L ${x} ${y}`;
    px = x; py = y;
  }
  if (closed) d += ' Z';
  return d;
}

export function strokeObj(pts) {
  const s = simplify(pts, CFG.simplifyTol);
  const bbox = bboxOf(s);
  const closed = isClosed(s, bbox);
  return { d: toPath(s, closed), bbox, closed };
}

export function drawStroke(ctx, pts) {
  ctx.lineWidth = CFG.width;
  ctx.strokeStyle = CFG.color;
  ctx.fillStyle = CFG.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
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

export function createDrawSurface({ mount, targets, store, ink, onStroke, visible }) {
  const fixed = mount === document.body;

  const canvas = chrome(document.createElement('canvas'));
  Object.assign(canvas.style, {
    position: fixed ? 'fixed' : 'absolute', inset: '0', zIndex: 99990,
    pointerEvents: 'none', cursor: 'crosshair', touchAction: 'none',
  });
  mount.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // where the canvas' own (0,0) sits in client coordinates
  function canvasOrigin() {
    if (fixed) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    return { x: r.left, y: r.top };
  }

  // Live capture stays in client px so the lazy brush keeps its exact feel; the
  // stroke is converted to its target's basis once, at finishStroke.
  let live = null;
  let brush = null;
  let bound = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = fixed ? innerWidth : mount.clientWidth;
    const h = fixed ? innerHeight : mount.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  // ---------- input: lazy brush ----------
  // The brush only moves when the pointer pulls it more than the lazy radius
  // away, so high-frequency hand wobble never enters the stroke, while sustained
  // motion (a drawn curve) drags the brush along faithfully. The radius follows
  // pointer speed: slow, deliberate drawing shrinks it so small intentional
  // detail survives. Each stroke point records the smoothed pointer speed for
  // the post-stroke filter.

  let raw = null;   // last raw pointer sample {x, y, t}
  let speed = 0;    // exponential moving average of pointer speed, px/ms

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

  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    // a stroke binds to the target under the pointer here and never rebinds:
    // the ink may overshoot the panel edge and still belong to that panel
    bound = targets.hitTest(e.clientX, e.clientY);
    brush = { x: e.clientX, y: e.clientY };
    raw = { ...brush, t: e.timeStamp };
    speed = 0;
    live = [{ ...brush, v: 0 }];
    redraw();
  });

  canvas.addEventListener('pointermove', e => {
    if (!live) return;
    let events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (events.length === 0) events = [e];
    for (const ev of events) follow(ev.clientX, ev.clientY, ev.timeStamp);
    redraw();
  });

  function finishStroke() {
    if (!live) return;
    const pts = live.length > 1 ? smooth(live) : live;
    const t = bound || targets.get('page');
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
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', finishStroke);

  // ---------- render ----------

  // Stored points come back through the target's basis. Viewbox targets render
  // as SVG marks in an overlay that shares their viewBox (no scaling math, no
  // DPR, no redraw on resize); fraction targets and the in-progress stroke
  // render on the canvas.
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
    canvas.style.pointerEvents = v ? 'auto' : 'none';
  }

  function destroy() {
    canvas.remove();
  }

  setActive(false);
  resize();

  return { canvas, resize, redraw, setActive, destroy };
}
