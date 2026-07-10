// notes.js — element + area + region notes for review feedback, one hybrid tool.
// While active, hovering highlights the topmost element under the cursor. A click
// records that element's identity (selector, tag/id/classes, text, ancestors) so a
// pasted JSON note pins the exact element. Press-drag selects an area: every element
// mostly inside the box is captured, anchored to their common ancestor for context.
// A drag that starts on a graphic (canvas, img, video, svg) and stays inside it
// instead marks a region, stored as fractions 0-1 of that element's box. Notes
// persist to localStorage per page and register with the feedback hub for
// toggle / clear / COPY JSON.
//
// Part of redpen. Load as a module (import './notes.js') or via dist/redpen.js.
// Console:   NotesTool.on(true) · NotesTool.clear() · NotesTool.layout()

import { register } from './feedback-hub.js';

if (!window.NotesTool) {

const STORE = 'la-notes:' + location.pathname;
const round3 = n => Math.round(n * 1000) / 1000;

// v2 items: { id, note, type: 'element'|'region'|'area', target, rect?, region?, elements?, truncated? }
// v1 ({ annos, counter }) came from the scene pages, where regions were fractions
// of the 560x373 #gl canvas: migrate them to region items targeting #gl.
let items = [], counter = 0, on = false;
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || '{}');
  if (saved.v === 2) { items = saved.items || []; counter = saved.counter || 0; }
  else if (saved.annos) {
    items = saved.annos.map(a => ({
      id: a.id, note: a.note, type: 'region',
      target: { selector: '#gl', tag: 'canvas' },
      rect: { w: 560, h: 373 },
      region: { x: a.x, y: a.y, w: a.w, h: a.h },
    }));
    counter = saved.counter || items.length;
  }
} catch {}

function save() {
  localStorage.setItem(STORE, JSON.stringify({ v: 2, counter, items }));
}

// ---------- DOM ----------

const style = document.createElement('style');
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

const panel = document.createElement('aside');
panel.id = 'laNotes';
panel.dataset.laUi = '1';
panel.setAttribute('sap-ignore', '');
panel.innerHTML = `<h2>Notes</h2>
  <p class="hint">Toggle NOTES, then click an element or drag a box across an area. COPY JSON sends it all back.</p>
  <div id="laNoteList"></div>`;
document.body.appendChild(panel);
const list = panel.querySelector('#laNoteList');

const markers = document.createElement('div');
markers.id = 'laMarkers';
markers.dataset.laUi = '1';
markers.setAttribute('sap-ignore', '');
document.body.appendChild(markers);

const overlay = document.createElement('div');
overlay.id = 'laOverlay';
overlay.dataset.laUi = '1';
overlay.setAttribute('sap-ignore', '');
document.body.appendChild(overlay);

// ---------- element identity ----------

function topElementAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest('[data-la-ui]')) continue;
    return el;
  }
  return document.body;
}

// the region basis: nearest graphic up the tree (for svg, the outermost <svg>)
function graphicBasis(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const t = n.tagName.toLowerCase();
    if (t === 'canvas' || t === 'img' || t === 'video') return n;
    if (t === 'svg' && !n.ownerSVGElement) return n;
  }
  return null;
}

function nthOfType(el) {
  const p = el.parentElement;
  if (!p) return 0;
  const sibs = [...p.children].filter(s => s.tagName === el.tagName);
  return sibs.length > 1 ? sibs.indexOf(el) + 1 : 0;
}

function cssPath(el) {
  if (el === document.body) return 'body';
  if (el === document.documentElement) return 'html';
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    let seg = n instanceof SVGElement ? n.tagName : n.tagName.toLowerCase();
    if (n.id) { parts.unshift(seg + '#' + CSS.escape(n.id)); break; }
    seg += [...n.classList].slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
    const nth = nthOfType(n);
    if (nth) seg += `:nth-of-type(${nth})`;
    parts.unshift(seg);
  }
  return parts.join(' > ');
}

function describe(el, lite) {
  const t = { selector: cssPath(el), tag: el.tagName.toLowerCase() };
  if (el.id) t.id = el.id;
  if (el.classList.length) t.classes = [...el.classList];
  const nth = nthOfType(el);
  if (nth) t.nth = nth;
  const text = ((el.innerText ?? el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, lite ? 60 : 100);
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
  try { return document.querySelector(target.selector); } catch { return null; }
}

// ---------- panel rows + markers ----------

const rowEls = new Map();

function renderRows() {
  list.innerHTML = '';
  rowEls.clear();
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'laNoteRow';
    row.title = it.target.selector;
    const num = document.createElement('span'); num.className = 'num'; num.textContent = it.id;
    const input = document.createElement('input');
    input.value = it.note;
    input.placeholder = "what's wrong here";
    input.addEventListener('input', () => { it.note = input.value; save(); });
    const del = document.createElement('button'); del.textContent = '×'; del.title = 'delete';
    del.addEventListener('click', () => {
      items = items.filter(x => x !== it);
      save(); renderRows(); layout();
    });
    row.append(num, input, del);
    list.appendChild(row);
    rowEls.set(it, row);
  }
}

// markers live in a document-anchored layer; placing via rect differences keeps
// them correct whatever the page's body offset or scroll position is
function place(el, r) {
  const base = markers.getBoundingClientRect();
  el.style.left = (r.left - base.left) + 'px';
  el.style.top = (r.top - base.top) + 'px';
  el.style.width = r.width + 'px';
  el.style.height = r.height + 'px';
}

function layout() {
  markers.querySelectorAll('.laBox').forEach(el => { if (el !== rubber) el.remove(); });
  for (const it of items) {
    const el = resolve(it.target);
    rowEls.get(it)?.classList.toggle('stale', !el);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'laBox' + (it.type === 'element' ? ' el' : '');
    box.innerHTML = `<span class="tag">${it.id}</span>`;
    if (it.region) {
      place(box, {
        left: r.left + it.region.x * r.width, top: r.top + it.region.y * r.height,
        width: it.region.w * r.width, height: it.region.h * r.height,
      });
    } else {
      place(box, r);
    }
    markers.appendChild(box);
  }
}

// ---------- interaction ----------

let hover = null;
function setHover(r) {
  if (!r) { hover?.remove(); hover = null; return; }
  if (!hover) { hover = document.createElement('div'); hover.className = 'laHover'; markers.appendChild(hover); }
  place(hover, r);
}

let press = null, rubber = null;

overlay.addEventListener('pointermove', e => {
  if (press) { dragMove(e); return; }
  const el = topElementAt(e.clientX, e.clientY);
  const basis = graphicBasis(el);
  overlay.style.cursor = basis ? 'crosshair' : 'pointer';
  setHover((basis || el).getBoundingClientRect());
});

overlay.addEventListener('pointerleave', () => { if (!press) setHover(null); });

overlay.addEventListener('pointerdown', e => {
  try { overlay.setPointerCapture(e.pointerId); } catch {}
  const el = topElementAt(e.clientX, e.clientY);
  press = { x: e.clientX, y: e.clientY, el, basis: graphicBasis(el), area: false };
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
    left: Math.min(press.x, e.clientX), top: Math.min(press.y, e.clientY),
    width: Math.abs(e.clientX - press.x), height: Math.abs(e.clientY - press.y),
  };
}

// a drag confined to a graphic marks a region of it; leaving the graphic
// (by more than 8px) upgrades the drag to an area selection for good
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
    rubber = document.createElement('div');
    rubber.className = 'laBox';
    markers.appendChild(rubber);
  }
  escapeCheck(e);
  place(rubber, press.basis && !press.area ? clampedRegion(e) : freeRect(e));
}

overlay.addEventListener('pointerup', e => {
  if (!press) return;
  if (rubber) {
    // the release point may have escaped the graphic without a final pointermove
    escapeCheck(e);
    rubber.remove(); rubber = null;
    const graphic = press.basis && !press.area;
    const r = graphic ? clampedRegion(e) : freeRect(e);
    if (r.width <= 6 && r.height <= 6) {
      addItem({ type: 'element', target: describe(press.el) });
    } else if (graphic) {
      addItem({
        type: 'region',
        target: describe(press.basis),
        rect: { w: Math.round(r.b.width), h: Math.round(r.b.height) },
        region: {
          x: round3((r.left - r.b.left) / r.b.width),
          y: round3((r.top - r.b.top) / r.b.height),
          w: round3(r.width / r.b.width),
          h: round3(r.height / r.b.height),
        },
      });
    } else {
      addAreaItem(r);
    }
  } else {
    addItem({ type: 'element', target: describe(press.el) });
  }
  press = null;
});

overlay.addEventListener('pointercancel', () => {
  rubber?.remove(); rubber = null; press = null;
});

// ---------- area selection ----------
// An element counts as selected when at least 60% of its own box lies inside the
// drag rect. Selected elements absorb their descendants (the walk stops there),
// so only the outermost survivors are listed. svgs are atomic. Fixed-position
// overlays (floating chips, toasts) that drift into the rect are listed with a
// fixed flag but never pick the anchor, or the anchor would degrade to body.
// The anchor is chosen from every pick and must have a real box (a zero-size
// wrapper like display:contents can't serve as a coordinate basis); the 15-item
// cap applies only to the exported listing.

const MAX_AREA_ELEMENTS = 15;

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
        if (ix > 0 && iy > 0 && (ix * iy) / (r.width * r.height) >= 0.6
            && getComputedStyle(el).visibility !== 'hidden') {
          picked.push(el);
          continue;
        }
      } else if (getComputedStyle(el).display === 'none') {
        continue;
      }
      if (el.tagName.toLowerCase() !== 'svg') walk(el);
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
    if (getComputedStyle(n).position === 'fixed') return true;
  }
  return false;
}

function addAreaItem(r) {
  const els = elementsInArea(r);
  const fixed = new Set(els.filter(inFixed));
  const flow = els.filter(el => !fixed.has(el));
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
    type: 'area',
    target: describe(anchor),
    rect: { w: Math.round(b.width), h: Math.round(b.height) },
    region: {
      x: round3((r.left - b.left) / b.width),
      y: round3((r.top - b.top) / b.height),
      w: round3(r.width / b.width),
      h: round3(r.height / b.height),
    },
    elements: listed.map(el => {
      const d = describe(el, true);
      if (fixed.has(el)) d.fixed = true;
      return d;
    }),
    ...(truncated ? { truncated } : {}),
  });
}

function addItem(fields) {
  const it = { id: ++counter, note: '', ...fields };
  items.push(it);
  save(); renderRows(); layout();
  rowEls.get(it)?.querySelector('input').focus();
}

// ---------- tool surface ----------

function setOn(v) {
  on = v;
  overlay.style.display = v ? 'block' : 'none';
  if (!v) { setHover(null); rubber?.remove(); rubber = null; press = null; }
  layout();
}

function clearAll() {
  items = []; counter = 0;
  save(); renderRows(); layout();
}

function getData() {
  return {
    coords: 'region = fractions of the target element box, usually 0-1, beyond that when the drag exceeded the box; area items also list the elements selected inside',
    items: items.map(it => ({
      id: it.id, note: it.note, type: it.type, target: it.target,
      ...(it.region ? { rect: it.rect, region: it.region } : {}),
      ...(it.elements ? { elements: it.elements } : {}),
      ...(it.truncated ? { truncated: it.truncated } : {}),
    })),
  };
}

const handle = register({ id: 'notes', label: 'NOTES', getOn: () => on, setOn, clear: clearAll, getData });

window.addEventListener('resize', layout);

renderRows();
// scene canvases are built after this module runs: retry until every selector resolves
let tries = 0;
(function settle() {
  layout();
  if (tries++ < 20 && items.some(it => !resolve(it.target))) setTimeout(settle, 500);
})();

window.NotesTool = {
  on: v => handle.setOn(v),
  clear: clearAll,
  layout,
  items: () => items,
};

}
