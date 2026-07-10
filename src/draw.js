// draw.js — freehand feedback overlay. A full-screen sketch layer toggled from
// the feedback hub bar; strokes are 3px black ink, jitter-smoothed. Drawings
// persist to localStorage per page (like the notes) and are anchored to the
// illustration #frame when one exists, else to the document.
//
// Part of redpen. Load as a module (import './draw.js') or via dist/redpen.js.
// Console tuning:          DrawTool.tune({ lazyRadius: 6, smoothWindow: 3 })
// Undo while drawing:      cmd/ctrl+Z   ·   DrawTool.undo()   ·   DrawTool.clear()

import { register } from './feedback-hub.js';

if (!window.DrawTool) {

const CFG = {
  width: 3,          // stroke width, px
  color: '#000',
  lazyRadius: 4,     // brush trails the pointer by this many px; the live jitter killer
  resampleStep: 3,   // finished stroke gets one point per N px of arc length
  smoothWindow: 4,   // box-filter half-width (points each side) on the finished stroke
  smoothPasses: 2,   // box-filter iterations
};

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
// The brush only moves when the pointer pulls it more than lazyRadius away,
// so high-frequency hand wobble never enters the stroke, while sustained
// motion (a drawn curve) drags the brush along faithfully.

function follow(x, y) {
  const dx = x - brush.x, dy = y - brush.y;
  const d = Math.hypot(dx, dy);
  if (d <= CFG.lazyRadius) return;
  const k = (d - CFG.lazyRadius) / d;
  brush.x += dx * k;
  brush.y += dy * k;
  live.push({ x: brush.x, y: brush.y });
}

canvas.addEventListener('pointerdown', e => {
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const o = origin();
  brush = { x: e.clientX - o.x, y: e.clientY - o.y };
  live = [{ ...brush }];
  redraw();
});

canvas.addEventListener('pointermove', e => {
  if (!live) return;
  let events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (events.length === 0) events = [e];
  const o = origin();
  for (const ev of events) follow(ev.clientX - o.x, ev.clientY - o.y);
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
// which would bias any filter), then box-filter with pinned endpoints.

function resample(pts, step) {
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
  let p = resample(pts, CFG.resampleStep);
  for (let k = 0; k < CFG.smoothPasses; k++) p = boxFilter(p, CFG.smoothWindow);
  return p;
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

// export strokes as fractions of the illustration frame when one exists, so the
// draw namespace shares the notes tool's coordinate system
function getData() {
  const f = document.getElementById('frame');
  const r3 = n => Math.round(n * 1000) / 1000;
  if (f) {
    const r = f.getBoundingClientRect();
    return {
      coords: 'fractions 0-1 of the illustration frame',
      frame: { w: Math.round(r.width), h: Math.round(r.height) },
      strokes: strokes.map(s => s.map(p => [r3(p.x / r.width), r3(p.y / r.height)])),
    };
  }
  const r1 = n => Math.round(n * 10) / 10;
  return { coords: 'px from document top-left', strokes: strokes.map(s => s.map(p => [r1(p.x), r1(p.y)])) };
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
