// note-surface.js — the pointer surface for element / area / region notes.
// Hovering highlights the topmost element under the cursor; a click records that
// element's identity; a press-drag selects an area (every element mostly inside
// the box, anchored to their common ancestor); a drag that starts on a graphic
// and stays inside it marks a region of that graphic.
//
// A gesture binds to the registered target under the pointer at pointerdown. On
// a viewbox target the region is stored in the artwork's own user units; on the
// page (fraction) target it is stored as fractions 0-1, exactly as before.
//
// Injects only the feedback medium (capture overlay, hover box, numbered
// markers) into `mount`. No panel, no bar, no keyboard.

import { describe as defaultDescribe, graphicBasis, resolve, topElementAt } from './identify.js';
import { PAGE } from './targets.js';

const round3 = n => Math.round(n * 1000) / 1000;
const MAX_AREA_ELEMENTS = 15;

// A tap on a pixel graphic has no sub-element to name, so it drops a pinpoint at
// the exact spot instead of a note on the whole graphic. SVG is deliberately not
// here: on artwork describe() names the shape under the cursor, which is real
// information a bare point would throw away.
const POINT_TAGS = new Set(['canvas', 'img', 'video']);
const pointGraphic = el => !!el && POINT_TAGS.has(el.tagName.toLowerCase());

const SURFACE_CSS = `
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

export function injectSurfaceStyles() {
  if (document.getElementById('laSurfaceStyle')) return;
  const style = document.createElement('style');
  style.id = 'laSurfaceStyle';
  style.textContent = SURFACE_CSS;
  document.head.appendChild(style);
}

function chrome(el, cls, id) {
  el.className = cls;
  if (id) el.id = id;
  el.dataset.laUi = '1';
  el.setAttribute('sap-ignore', '');
  return el;
}

export function createNoteSurface({ mount, targets, store, identify, addNote, afterLayout, visible }) {
  const describe = identify || defaultDescribe;
  injectSurfaceStyles();

  const markers = chrome(document.createElement('div'), 'laMarkers', 'laMarkers');
  mount.appendChild(markers);

  const overlay = chrome(document.createElement('div'), 'laOverlay', 'laOverlay');
  if (mount !== document.body) overlay.style.position = 'absolute';
  mount.appendChild(overlay);

  // markers live in a document-anchored layer; placing via rect differences keeps
  // them correct whatever the page's body offset or scroll position is
  function place(el, r) {
    const base = markers.getBoundingClientRect();
    el.style.left = (r.left - base.left) + 'px';
    el.style.top = (r.top - base.top) + 'px';
    el.style.width = r.width + 'px';
    el.style.height = r.height + 'px';
  }

  // where a stored note sits on screen right now, in its own target's basis
  function screenRect(t, note) {
    if (!note.box) {
      const el = resolve(note.target);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
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
      left: r.left + note.box.x * r.width, top: r.top + note.box.y * r.height,
      width: note.box.w * r.width, height: note.box.h * r.height,
    };
  }

  // a point note stores a fraction of its graphic's box, exactly as a region does
  function screenPoint(t, note) {
    const base = note.target ? resolve(note.target) : null;
    const r = base ? base.getBoundingClientRect() : targets.rectOf(t);
    if (!r || !r.width || !r.height) return null;
    return { x: r.left + note.point.x * r.width, y: r.top + note.point.y * r.height };
  }

  // a point marker owns its size in css; only its centre is placed
  function placePoint(el, x, y) {
    const base = markers.getBoundingClientRect();
    el.style.left = (x - base.left) + 'px';
    el.style.top = (y - base.top) + 'px';
  }

  function layout() {
    markers.querySelectorAll('.laBox').forEach(el => { if (el !== rubber) el.remove(); });
    for (const [id, g] of store.state.targets) {
      const t = targets.get(id);
      if (!t) continue;
      const show = visible ? visible(id) : true;
      if (!show) continue;
      for (const note of g.notes) {
        // point markers keep the .laBox class so the clear at the top of layout()
        // sweeps them too
        if (note.kind === 'point' && note.point) {
          const p = screenPoint(t, note);
          if (!p) continue;
          const dot = document.createElement('div');
          dot.className = 'laBox laPoint';
          dot.dataset.laTarget = id;
          dot.innerHTML = `<span class="tag">${note.id}</span>`;
          placePoint(dot, p.x, p.y);
          markers.appendChild(dot);
          continue;
        }
        const r = screenRect(t, note);
        if (!r) continue;
        const box = document.createElement('div');
        box.className = 'laBox' + (note.kind === 'element' ? ' el' : '');
        box.dataset.laTarget = id;
        box.innerHTML = `<span class="tag">${note.id}</span>`;
        place(box, r);
        markers.appendChild(box);
      }
    }
    afterLayout?.();
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
    // the gesture binds to the target under the pointer and never rebinds
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

  // a region on a viewbox target is stored in the artwork's own user units
  function viewboxRegion(t, r) {
    const a = targets.toBasis(t, r.left, r.top);
    const b = targets.toBasis(t, r.left + r.width, r.top + r.height);
    if (!a || !b) return null;
    return { x: round3(a.x), y: round3(a.y), w: round3(b.x - a.x), h: round3(b.y - a.y) };
  }

  // What a context provider is handed: where the note was made, in client px, so
  // a provider can ask its own scene what sits under that exact point. `box` is
  // the gesture rect for a region or an area, null for a tap or a point.
  function gestureOf(kind, r) {
    return {
      el: press.el,
      info: {
        kind, x: press.x, y: press.y, targetId: press.target.id,
        box: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
      },
    };
  }

  // a tap: a pinpoint on a pixel graphic, a note on the element anywhere else.
  // The point files exactly where a region drag on the same graphic files — under
  // the page group, carrying the graphic's descriptor and its box — so both kinds
  // read back through one rule.
  function addTap() {
    if (pointGraphic(press.basis)) {
      const b = press.basis.getBoundingClientRect();
      if (b.width && b.height) {
        addNote(PAGE, {
          kind: 'point',
          target: describe(press.basis),
          rect: { w: Math.round(b.width), h: Math.round(b.height) },
          point: {
            x: round3((press.x - b.left) / b.width),
            y: round3((press.y - b.top) / b.height),
          },
        }, gestureOf('point'));
        return;
      }
    }
    addNote(press.target.id, { kind: 'element', target: describe(press.el) }, gestureOf('element'));
  }

  overlay.addEventListener('pointerup', e => {
    if (!press) return;
    const t = press.target;
    const viewbox = targets.isViewbox(t);
    if (rubber) {
      // the release point may have escaped the graphic without a final pointermove
      escapeCheck(e);
      rubber.remove(); rubber = null;
      const graphic = press.basis && !press.area;
      const r = graphic ? clampedRegion(e) : freeRect(e);
      if (r.width <= 6 && r.height <= 6) {
        addTap();
      } else if (viewbox && graphic) {
        const box = viewboxRegion(t, r);
        if (box) addNote(t.id, { kind: 'region', box }, gestureOf('region', r));
        else addNote(t.id, { kind: 'element', target: describe(press.el) }, gestureOf('element', r));
      } else if (graphic) {
        addNote(PAGE, {
          kind: 'region',
          target: describe(press.basis),
          rect: { w: Math.round(r.b.width), h: Math.round(r.b.height) },
          box: {
            x: round3((r.left - r.b.left) / r.b.width),
            y: round3((r.top - r.b.top) / r.b.height),
            w: round3(r.width / r.b.width),
            h: round3(r.height / r.b.height),
          },
        }, gestureOf('region', r));
      } else {
        addAreaNote(r, gestureOf('area', r));
      }
    } else {
      addTap();
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

  function addAreaNote(r, gesture) {
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
    addNote(PAGE, {
      kind: 'area',
      target: describe(anchor),
      rect: { w: Math.round(b.width), h: Math.round(b.height) },
      box: {
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
    }, gesture);
  }

  // ---------- surface control ----------

  function setActive(v) {
    overlay.style.display = v ? 'block' : 'none';
    if (!v) { setHover(null); rubber?.remove(); rubber = null; press = null; }
    layout();
  }

  function destroy() {
    setHover(null);
    markers.remove();
    overlay.remove();
  }

  return { markers, overlay, layout, setActive, destroy };
}
