// engine.js — the headless redpen engine. Owns the data, the target registry,
// the two pointer surfaces, and the single-owner mode. Injects the feedback
// medium (capture overlay, hover box, numbered markers, ink canvas, per-target
// SVG ink overlays) into `mount` and nothing else: no panel, no bar, no global
// keyboard, no clipboard. Hosts drive it through methods and listen for events.
//
//   const pen = Redpen.create({ key, mount, storage, identify });
//   pen.addTarget({ id: 'p19', selector: '#p19', basis: { type: 'viewbox' } });
//   pen.addEventListener('change', e => render(e.detail));
//   pen.setMode('note');
//   pen.show('p19');   // the one call on panel switch

import { createStore } from './store.js';
import { createTargets, PAGE } from './targets.js';
import { createNoteSurface } from './note-surface.js';
import { createDrawSurface, CFG, strokeObj } from './draw-surface.js';
import { createInkLayer } from './ink-layer.js';
import { describe, resolve } from './identify.js';

export { CFG, PAGE };

export function create(opts = {}) {
  const key = opts.key ?? location.pathname;
  const mount = opts.mount ?? document.body;
  const storage = opts.storage ?? localStorage;
  const identify = opts.identify;

  const targets = createTargets();
  const store = createStore({ key, storage });
  if (store.migrated) store.save();

  let mode = null;
  let active = null;      // null shows every target's marks
  let destroyed = false;
  let normalized = false;

  const pen = new EventTarget();

  function emit(name, detail) {
    pen.dispatchEvent(new CustomEvent(name, { detail }));
  }

  const visible = id => active === null || active === id;

  const ink = createInkLayer({ mount, targets });

  const noteSurface = createNoteSurface({
    mount, targets, store, identify, visible,
    addNote: (targetId, fields) => {
      const g = store.group(targetId);
      const t = targets.get(targetId);
      if (t && !g.basis) g.basis = { ...t.basis };
      const item = { id: store.nextId(), text: '', ...fields };
      g.notes.push(item);
      store.save();
      noteSurface.layout();
      emit('change', { action: 'add', item });
      emit('item:add', { item });
    },
    afterLayout: () => emit('layout', {}),
  });

  const drawSurface = createDrawSurface({
    mount, targets, store, ink, visible,
    onStroke: () => {
      store.save();
      emit('change', { action: 'stroke' });
    },
  });

  // legacy draw pixels carry no basis of their own; the first layout with a real
  // box turns them into fractions like everything else
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
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, { passive: true });

  function eachGroup(targetId) {
    if (targetId != null) {
      const g = store.state.targets.get(targetId);
      return g ? [[targetId, g]] : [];
    }
    return [...store.state.targets];
  }

  function findNote(id) {
    for (const [targetId, g] of store.state.targets) {
      const item = g.notes.find(n => n.id === id);
      if (item) return { targetId, g, item };
    }
    return null;
  }

  // ---------- export projection ----------
  // Points are the internal model; the SVG path is a projection computed here.
  // Each target states its own coordinate rule, so an agent handed the feedback
  // knows exactly what the numbers mean.

  const VIEWBOX_RULE = 'note boxes and stroke paths are in the target SVG\'s own user units (its viewBox), the same coordinates the artwork is authored in';
  const FRACTION_RULE = 'note boxes are fractions of the target element box, usually 0-1, beyond that when the gesture exceeded it; stroke paths are integer px in the stated viewBox';

  function data(targetId) {
    const out = {};
    for (const [id, g] of eachGroup(targetId)) {
      const t = targets.get(id);
      const basis = g.basis || (t ? t.basis : { type: 'fraction' });
      const viewbox = basis.type === 'viewbox';
      // fraction points carry no scale of their own: project them into the
      // target's current pixel box so the exported path is readable px again
      let vb = viewbox ? ((t && targets.viewBoxOf(t)) || basis.viewBox || null) : null;
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
        coords: (viewbox ? VIEWBOX_RULE : FRACTION_RULE) + '; strokes in draw order, each path runs in draw direction',
        ...(vb ? { viewBox: vb } : {}),
        notes: g.notes.map(n => ({
          id: n.id, text: n.text, kind: n.kind,
          ...(n.target ? { target: n.target } : {}),
          ...(n.box ? { box: n.box } : {}),
          ...(n.rect ? { rect: n.rect } : {}),
          ...(n.elements ? { elements: n.elements } : {}),
          ...(n.truncated ? { truncated: n.truncated } : {}),
        })),
        strokes: g.strokes.map(s => {
          // a legacy stroke not yet normalized is already in px
          const k = s.px ? { x: 1, y: 1 } : scale;
          const pts = s.points.map(([x, y]) => ({ x: x * k.x, y: y * k.y }));
          return { id: s.id, ...strokeObj(pts), width: s.width };
        }),
      };
    }
    return { targets: out };
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
      if (active === id) { active = null; emit('target', { target: active }); }
      repaint();
      return true;
    },
    targets: () => targets.list.map(t => t.id),
    // show(id) is the one call on panel switch: it re-resolves the target's
    // element, recomputes the transform, repaints its marks and hides the rest.
    // Calling it with the current id is a cheap re-bind after an SVG swap.
    show(id) {
      const next = id == null ? null : id;
      if (next !== null && !targets.get(next)) return false;
      active = next;
      repaint();
      emit('target', { target: active });
      return true;
    },
    target: () => active,

    // ---------- mode ----------
    setMode(v) {
      const next = v || null;
      if (next === mode) return;
      mode = next;
      noteSurface.setActive(mode === 'note');
      drawSurface.setActive(mode === 'draw');
      emit('mode', { mode });
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
      emit('change', { action: 'note', item: hit.item });
    },
    remove(id) {
      const hit = findNote(id);
      if (!hit) return;
      hit.g.notes = hit.g.notes.filter(n => n !== hit.item);
      store.save();
      repaint();
      emit('change', { action: 'remove', item: hit.item });
    },
    undoStroke(targetId) {
      const groups = eachGroup(targetId).filter(([, g]) => g.strokes.length);
      if (!groups.length) return;
      // without a target, undo the most recently drawn stroke anywhere
      let pick = groups[0];
      for (const entry of groups) {
        if (entry[1].strokes[entry[1].strokes.length - 1].id > pick[1].strokes[pick[1].strokes.length - 1].id) pick = entry;
      }
      pick[1].strokes.pop();
      store.save();
      repaint();
      emit('change', { action: 'undo' });
    },
    clearNotes(targetId) {
      for (const [, g] of eachGroup(targetId)) g.notes = [];
      store.save();
      repaint();
      emit('change', { action: 'clear' });
    },
    clearStrokes(targetId) {
      for (const [, g] of eachGroup(targetId)) g.strokes.length = 0;
      store.save();
      repaint();
      emit('change', { action: 'clear' });
    },
    clear(targetId) {
      for (const [, g] of eachGroup(targetId)) { g.notes = []; g.strokes.length = 0; }
      if (targetId == null) store.state.counter = 0;
      store.save();
      repaint();
      emit('change', { action: 'clear' });
    },
    data,
    layout: repaint,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll);
      noteSurface.destroy();
      drawSurface.destroy();
      ink.destroy();
      emit('change', { action: 'destroy' });
    },
  });

  // scene canvases and swapped-in panels are built after this module runs:
  // retry until every note's element resolves
  let tries = 0;
  (function settle() {
    if (destroyed) return;
    repaint();
    const pending = [...store.state.targets].some(([, g]) => g.notes.some(n => n.target && !resolve(n.target)));
    if (tries++ < 20 && pending) setTimeout(settle, 500);
  })();

  return pen;
}

export { describe };
