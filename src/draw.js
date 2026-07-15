// draw.js — freehand feedback overlay. A full-screen sketch layer toggled from
// the feedback hub bar; strokes are 3px black ink, jitter-smoothed. Smoothing
// adapts to pointer speed: slow, deliberate drawing is only lightly smoothed,
// fast strokes get the full filter. Drawings persist to localStorage per page
// (like the notes) and are anchored to the illustration #frame when one
// exists, else to the document.
//
// Part of redpen. Load as a module (import './draw.js') or via dist/redpen.js.
// Console tuning:          DrawTool.tune({ lazyRadius: 6, slowBlend: 0.5 })
// Undo while drawing:      cmd/ctrl+Z   ·   DrawTool.undo()   ·   DrawTool.clear()

import { register } from './feedback-hub.js';

if (!window.DrawTool) {

const CFG = {
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
function speedT(v) {
  return Math.max(0, Math.min(1, (v - CFG.slowSpeed) / (CFG.fastSpeed - CFG.slowSpeed)));
}

const canvas = document.createElement('canvas');
canvas.dataset.laUi = '1';
canvas.setAttribute('sap-ignore', '');
Object.assign(canvas.style, {
  position: 'fixed', inset: '0', zIndex: 99990,
  pointerEvents: 'none', cursor: 'crosshair', touchAction: 'none',
});
document.body.appendChild(canvas);
const ctx = canvas.getContext('2d');

// All stroke points are stored relative to the illustration #frame when one
// exists (falling back to the document origin), so saved drawings stay glued
// to the content across window sizes and scrolling. Rendering translates by
// the anchor's current position.
function origin() {
  const f = document.getElementById('frame');
  if (!f) return { x: -scrollX, y: -scrollY };
  const r = f.getBoundingClientRect();
  return { x: r.left, y: r.top };
}

const STORE = 'la-draw:' + location.pathname;
const strokes = [];
try {
  for (const s of JSON.parse(localStorage.getItem(STORE) || '[]')) {
    strokes.push(s.map(([x, y]) => ({ x, y })));
  }
} catch {}
function saveStrokes() {
  const r1 = n => Math.round(n * 10) / 10;
  localStorage.setItem(STORE, JSON.stringify(strokes.map(s => s.map(p => [r1(p.x), r1(p.y)]))));
}

let live = null;
let brush = null;
let on = false;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}
window.addEventListener('resize', resize);
window.addEventListener('scroll', () => redraw(), { passive: true });

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
  const o = origin();
  brush = { x: e.clientX - o.x, y: e.clientY - o.y };
  raw = { ...brush, t: e.timeStamp };
  speed = 0;
  live = [{ ...brush, v: 0 }];
  redraw();
});

canvas.addEventListener('pointermove', e => {
  if (!live) return;
  let events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (events.length === 0) events = [e];
  const o = origin();
  for (const ev of events) follow(ev.clientX - o.x, ev.clientY - o.y, ev.timeStamp);
  redraw();
});

function finishStroke() {
  if (!live) return;
  strokes.push(live.length > 1 ? smooth(live) : live);
  live = null;
  saveStrokes();
  redraw();
}
canvas.addEventListener('pointerup', finishStroke);
canvas.addEventListener('pointercancel', finishStroke);

window.addEventListener('keydown', e => {
  if (!on) return;
  if (e.target.closest && e.target.closest('input, textarea')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    strokes.pop();
    saveStrokes();
    redraw();
  }
});

// ---------- post-stroke smoothing ----------
// Resample to even spacing (raw pointer points bunch up when the hand slows,
// which would bias any filter), then box-filter with pinned endpoints. The
// filtered stroke is blended back toward the resampled original by pointer
// speed: fast segments keep the full correction, slow deliberate segments
// keep only slowBlend of it.

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

function boxFilter(pts, win) {
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { ...p };
    let sx = 0, sy = 0, n = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(pts.length - 1, i + win); j++) {
      sx += pts[j].x; sy += pts[j].y; n++;
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

// ---------- render ----------

function drawStroke(pts) {
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

function redraw() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const o = origin();
  ctx.save();
  ctx.translate(o.x, o.y);
  for (const s of strokes) drawStroke(s);
  if (live) drawStroke(live);
  ctx.restore();
}

// ---------- hub registration ----------

function clearAll() {
  strokes.length = 0;
  saveStrokes();
  redraw();
}

function setOn(v) {
  on = v;
  canvas.style.pointerEvents = v ? 'auto' : 'none';
}
setOn(false);
resize();

// ---------- export ----------
// Points are the internal model; the SVG path is a projection computed here.
// Each stroke: RDP-simplify, then emit an absolute-integer M/L path (Z when
// the stroke closes on itself) plus its bbox. One coordinate rule everywhere:
// integer px in a stated viewBox — the illustration frame when one exists
// (points are already stored frame-relative), else the document.

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

function bboxOf(pts) {
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
    px = x; py = y;
  }
  if (closed) d += ' Z';
  return d;
}

function strokeObj(pts) {
  const s = simplify(pts, CFG.simplifyTol);
  const bbox = bboxOf(s);
  const closed = isClosed(s, bbox);
  return { d: toPath(s, closed), bbox, closed };
}

function getData() {
  const f = document.getElementById('frame');
  const dims = f
    ? (r => [Math.round(r.width), Math.round(r.height)])(f.getBoundingClientRect())
    : [document.documentElement.scrollWidth, document.documentElement.scrollHeight];
  return {
    coords: (f ? 'integer px from the illustration frame top-left (the viewBox)' : 'integer px from the document top-left (the viewBox)')
      + '; strokes in draw order, each path runs in draw direction',
    viewBox: [0, 0, dims[0], dims[1]],
    strokes: strokes.map(strokeObj),
  };
}

const handle = register({ id: 'draw', label: 'DRAW', labelOn: 'DRAWING', getOn: () => on, setOn, clear: clearAll, getData });

window.DrawTool = {
  cfg: CFG,
  tune: o => Object.assign(CFG, o),
  on: v => handle.setOn(v),
  undo: () => { strokes.pop(); saveStrokes(); redraw(); },
  clear: clearAll,
  strokes,
};

}
