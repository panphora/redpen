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
import { mark, chrome as markChrome } from './mark.js';

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
  .laBox.laPoint { width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%; background: #e5484d; border-color: #FDFDFC; }
  /* The tag carries no number. A marker's job is to say "something was said
     here", and the id it used to show was only ever useful to whoever was
     reading the export, which still carries it. Losing the digits also lets the
     tag be the small round click target that reopens the comment. */
  .laBox .tag { position: absolute; top: -7px; left: -7px; width: 13px; height: 13px; box-sizing: border-box;
    background: #e5484d; border: 2px solid #FDFDFC; border-radius: 50%;
    pointer-events: auto; cursor: pointer; }
  /* A point marker is already a dot, so it is its own click target rather than
     wearing a second one. */
  .laBox.laPoint { pointer-events: auto; cursor: pointer; }
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

// A chip, and the popover that opens from it, sit just past the END of what they
// are about, not at the corner of its bounding box: a flagged phrase that wraps
// across two lines has a bounding box whose top-right corner is empty space in
// the middle of a sentence.
export function tailRect(el) {
  const rects = el.getClientRects();
  return rects.length ? rects[rects.length - 1] : el.getBoundingClientRect();
}

export function injectSurfaceStyles() {
  if (document.getElementById('laSurfaceStyle')) return;
  const style = mark(document.createElement('style'));
  style.id = 'laSurfaceStyle';
  style.textContent = SURFACE_CSS;
  document.head.appendChild(style);
}

function chrome(el, cls, id) {
  el.className = cls;
  if (id) el.id = id;
  return markChrome(el);
}

// What a marker says when you hover it, now that it has no number to read. The
// comment's own words are the only thing that identifies it on the page.
function markerTitle(note) {
  const said = (note.text || '').trim();
  if (!said) return 'an empty comment';
  return said.length > 72 ? said.slice(0, 71) + '…' : said;
}

export function createNoteSurface({ mount, targets, store, identify, addNote, afterLayout, visible, requests, onRequestClick, onNoteClick }) {
  const describe = identify || defaultDescribe;
  injectSurfaceStyles();

  const markers = chrome(document.createElement('div'), 'laMarkers', 'laMarkers');
  mount.appendChild(markers);

  // Delegated, because layout() wipes and rebuilds every marker on every scroll.
  // A handler attached per box would be re-attached dozens of times a second and
  // would leak the ones layout() already removed.
  //
  // .laMarkers stays pointer-events:none and so does the marker body. Only the
  // small tag (and a point marker, which IS its tag) opts back in, so a click
  // anywhere else still reaches the page being reviewed.
  markers.addEventListener('click', e => {
    const hit = e.target.closest('[data-la-note]');
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    onNoteClick?.(Number(hit.dataset.laNote));
  });

  // Request chips need their own layer because they sit at a different place on
  // the page than the marker they belong to. Like the marker tags above, this
  // layer sits BELOW the capture overlay, so turning on note mode makes both
  // inert — otherwise the first click of a volunteered comment would land on a
  // chip or an old marker and file a note about redpen's own chrome.
  const reqs = chrome(document.createElement('div'), 'laReqs', 'laReqs');
  mount.appendChild(reqs);

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
    // a dot placed against the wrong box still looks like a real annotation, so a
    // point whose graphic has gone is drawn nowhere rather than somewhere plausible
    if (note.target && !base) return null;
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
        // A resolved comment leaves the page entirely. It is still in the store
        // and still exports; the bar's resolved list is the way back to it.
        if (note.resolved) continue;
        // point markers keep the .laBox class so the clear at the top of layout()
        // sweeps them too
        if (note.kind === 'point' && note.point) {
          const p = screenPoint(t, note);
          if (!p) continue;
          const dot = document.createElement('div');
          dot.className = 'laBox laPoint' + (note.unread ? ' unread' : '');
          dot.dataset.laTarget = id;
          dot.dataset.laNote = note.id;
          dot.title = markerTitle(note);
          placePoint(dot, p.x, p.y);
          markers.appendChild(dot);
          continue;
        }
        const r = screenRect(t, note);
        if (!r) continue;
        const box = document.createElement('div');
        box.className = 'laBox' + (note.kind === 'element' ? ' el' : '');
        box.dataset.laTarget = id;
        box.dataset.laNote = note.id;
        const tag = document.createElement('span');
        tag.className = 'tag' + (note.unread ? ' unread' : '');
        tag.title = markerTitle(note);
        box.appendChild(tag);
        place(box, r);
        markers.appendChild(box);
      }
    }
    layoutRequests();
    afterLayout?.();
  }

  let openKey = null;

  function layoutRequests() {
    reqs.textContent = '';
    // measured once: .laReqs is a zero-size absolutely positioned layer, so
    // appending chips cannot move it, and reading it per chip forces a
    // synchronous layout on every scroll event
    const base = reqs.getBoundingClientRect();
    for (const r of (requests ? requests() : [])) {
      const el = (r.node && r.node.isConnected) ? r.node : resolve(r.target);
      if (!el) continue;
      const b = tailRect(el);
      if (!b.width && !b.height) continue;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'laReq'
        + (r.answered ? ' done' : '')
        + (r.stale ? ' stale' : '')
        + (r.key === openKey ? ' on' : '');
      chip.dataset.laReq = r.key;
      chip.title = r.ask || '';
      chip.textContent = r.answered ? '✓' : String(r.n);
      chip.style.left = (b.right - base.left) + 'px';
      chip.style.top = (b.top - base.top) + 'px';
      chip.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        onRequestClick?.(r.key);
      });
      reqs.appendChild(chip);
    }
  }

  // which chip reads as open, so the popover and the page agree about it
  function setOpenRequest(key) {
    if (openKey === key) return;
    openKey = key;
    layoutRequests();
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
    if (pointGraphic(press.basis) && !press.area) {
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
    try {
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
        // The descriptor rides along even though the viewBox already places this
        // note: it is what tells a consumer WHICH element on the page the region
        // is inside, and a transport that has to name the nearest keyed ancestor
        // has nothing to walk from without it.
        if (box) addNote(t.id, { kind: 'region', box, target: describe(press.basis) }, gestureOf('region', r));
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
    } finally {
      // a note that failed to save must not leave the gesture armed, or the next
      // bare pointermove starts a rubber band and files a phantom note
      press = null;
    }
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
    reqs.remove();
    overlay.remove();
  }

  return { markers, overlay, layout, setActive, setOpenRequest, destroy };
}
