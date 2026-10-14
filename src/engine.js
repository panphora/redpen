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
import { collectContext } from './context.js';

export { CFG, PAGE };

export function create(opts = {}) {
  const key = opts.key ?? location.pathname;
  const mount = opts.mount ?? document.body;
  const storage = opts.storage ?? localStorage;
  const identify = opts.identify;

  const targets = createTargets();

  let mode = null;
  let active = null;      // null shows every target's marks
  let destroyed = false;
  let normalized = false;
  let saveFailed = false;
  let loaded = false;

  const store = createStore({
    key, storage, backend: opts.backend,
    onLoad: ({ migrated }) => {
      if (destroyed) return;
      loaded = true;
      // the surfaces were held off until now, and the settle loop ran against an
      // empty store, so both are (re)started here against the real data
      applyMode();
      if (migrated) store.save();
      tries = 0;
      settle();
      emit('change', { action: 'load' });
    },
    // Storage is full, or gone. The notes are still in memory and still export,
    // so nothing is lost YET — but only if whoever is reviewing finds out, which
    // is why this is sticky rather than a passing message.
    onSaveError: err => {
      // a write in flight when destroy() ran would otherwise arm an unload guard
      // that nothing is left to remove, prompting for the rest of the page's life.
      // It still gets said out loud: the listeners are gone, so the console is the
      // only place a last write that failed on the way out can surface at all.
      if (destroyed) {
        console.warn('[redpen] a write failed after destroy — the last edit may not have been saved', err);
        return;
      }
      if (!saveFailed) {
        saveFailed = true;
        armUnloadGuard();
        console.warn('[redpen] feedback is no longer being saved — COPY JSON to keep it', err);
      }
      emit('save:error', { error: err });
    },
  });

  const pen = new EventTarget();

  function emit(name, detail) {
    pen.dispatchEvent(new CustomEvent(name, { detail }));
  }

  const visible = id => active === null || active === id;

  // ---------- requests ----------
  // A request is a question the page asks about one of its own elements. The page
  // declares the whole set on every load, and the engine never persists one: the
  // HTML is the truth about which questions exist, so there is no migration, no
  // reconciliation rule, and no question that resurrects from storage after the
  // author deleted it.
  //
  // Only the ANSWER is stored, and it stores the question it was answering. That
  // one extra field is what makes the two failure modes survivable: a question
  // that was reworded leaves a `stale` answer that can show both versions, and a
  // question that was deleted leaves an `orphaned` answer that still exports what
  // it was replying to. Nothing here ever deletes an answer on its own.

  let requests = [];

  const answerOf = key => store.answer(key);
  // a host that supplied its own identifier gets it everywhere, so one export
  // never mixes two descriptor shapes
  const describeEl = identify || describe;

  function requestView(r, i) {
    const a = answerOf(r.key);
    return {
      key: r.key,
      n: i + 1,
      ask: r.ask,
      target: r.target,
      answer: a ? a.said : '',
      answered: !!a,
      askedWas: a ? a.q : null,
      stale: !!a && a.q !== r.ask,
    };
  }

  // stored answers the page no longer asks for. Surfaced rather than swept: these
  // are the user's own words, and the author's edit is not consent to delete them.
  function orphans() {
    const declared = new Set(requests.map(r => r.key));
    return store.answerKeys()
      .filter(key => !declared.has(key))
      .map(key => {
        const a = store.answer(key);
        return { key, answer: a.said, askedWas: a.q, at: a.at || null };
      });
  }

  const ink = createInkLayer({ mount, targets });

  const noteSurface = createNoteSurface({
    mount, targets, store, identify, visible,
    requests: () => requests.map((r, i) => ({ ...requestView(r, i), node: r.node })),
    onRequestClick: key => {
      const i = requests.findIndex(r => r.key === key);
      if (i >= 0) emit('request:click', { request: requestView(requests[i], i) });
    },
    // The way back into a comment that already exists. Mirrors request:click,
    // and it is the whole reason marker tags take clicks: without it a comment's
    // popover opens once, while it is being written, and never again.
    onNoteClick: id => {
      const hit = findNote(id);
      if (hit) emit('item:click', { item: { ...hit.item, target_id: hit.targetId } });
    },
    addNote: (targetId, fields, gesture) => {
      const g = store.group(targetId);
      const t = targets.get(targetId);
      if (t && !g.basis) g.basis = { ...t.basis };
      // the page's own answer about the state this note was made in, collected
      // at creation because that state is gone by the time anyone reads the note
      const context = gesture ? collectContext(gesture.el, gesture.info) : null;
      const item = { id: store.nextId(), text: '', ...fields, ...(context ? { context } : {}) };
      g.notes.push(item);
      store.save();
      noteSurface.layout();
      emit('change', { action: 'add', item });
      emit('item:add', { item, sticky: !!(gesture && gesture.info && gesture.info.sticky) });
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
    // one-shot, so it must not fire against the pre-hydration store: legacy
    // px strokes arrive with the blob and would never be converted to fractions
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
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, { passive: true });

  // Armed only once saving has actually broken. Before that there is nothing to
  // lose, and a reload prompt on every page that ever loaded redpen is noise.
  let unloadGuard = null;
  function armUnloadGuard() {
    if (unloadGuard) return;
    unloadGuard = e => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', unloadGuard);
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
          ...(n.point ? { point: n.point } : {}),
          ...(n.rect ? { rect: n.rect } : {}),
          ...(n.elements ? { elements: n.elements } : {}),
          ...(n.truncated ? { truncated: n.truncated } : {}),
          ...(n.context ? { context: n.context } : {}),
          // The conversation and whether it was retired are feedback, so they
          // export. This list is a whitelist and review() reads notes through
          // it, so a field missing here is missing from Copy JSON as well, however
          // faithfully the store round-trips it. `unread` and `draft` stay out:
          // one is local read-state and the other is unsent scratch.
          ...(n.thread ? { thread: n.thread } : {}),
          ...(n.resolved ? { resolved: n.resolved } : {}),
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

  // The review projection: one flat list, because an answer and a volunteered
  // comment are the same thing to whoever reads them — a place on the page plus
  // something the reviewer said about it. Separate from data() on purpose: that
  // shape has live consumers, and its note fields are a fixed whitelist, so a
  // field added here would be silently dropped there.
  function review() {
    const items = [];
    requests.forEach((r, i) => {
      const v = requestView(r, i);
      items.push({
        kind: 'answer',
        ask: v.key,
        question: v.ask,
        said: v.answer || null,
        ...(v.answered ? {} : { skipped: true }),
        ...(v.stale ? { stale: true, askedWas: v.askedWas } : {}),
        anchor: v.target,
      });
    });
    for (const o of orphans()) {
      items.push({ kind: 'answer', ask: o.key, said: o.answer, orphaned: true, askedWas: o.askedWas, anchor: null });
    }
    const d = data();
    let coords = null;
    // Flattening is only safe for the page group, which has one coordinate rule.
    // A registered target stores its boxes in its own basis, so its rule and
    // viewBox ride along, or the agent reads user units as fractions.
    const bases = {};
    for (const [id, g] of Object.entries(d.targets)) {
      if (id === PAGE) { coords = g.coords; }
      else if (g.notes.length) {
        bases[id] = { basis: g.basis, coords: g.coords, ...(g.viewBox ? { viewBox: g.viewBox } : {}) };
      }
      for (const n of g.notes) {
        const { id: noteId, text, kind, target, ...geometry } = n;
        items.push({
          kind: 'comment',
          id: noteId,
          shape: kind,
          said: text,
          ...(id === PAGE ? {} : { target_id: id }),
          anchor: target || null,
          ...geometry,
        });
      }
    }
    const strokes = [];
    for (const [id, g] of Object.entries(d.targets)) {
      if (!g.strokes.length) continue;
      if (id !== PAGE && !bases[id]) bases[id] = { basis: g.basis, coords: g.coords, ...(g.viewBox ? { viewBox: g.viewBox } : {}) };
      for (const s of g.strokes) strokes.push({ ...(id === PAGE ? {} : { target_id: id }), ...s });
    }
    const pageBox = d.targets[PAGE] && d.targets[PAGE].viewBox;
    const asked = requests.map((r, i) => requestView(r, i));
    return {
      page: location.pathname.split('/').pop() || location.pathname,
      answered: asked.filter(v => v.answered).length,
      unanswered: asked.filter(v => !v.answered).length,
      orphaned: orphans().length,
      resolved: items.filter(i => i.kind === 'comment' && i.resolved).length,
      ...(strokes.length ? { strokes, ...(pageBox ? { viewBox: pageBox } : {}) } : {}),
      ...(coords ? { coords } : {}),
      ...(Object.keys(bases).length ? { targets: bases } : {}),
      items,
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
      applyMode();
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
      emit('change', { action: 'note', item: hit.item });
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
      emit('change', { action: 'notes' });
      return true;
    },
    remove(id) {
      const hit = findNote(id);
      if (!hit) return;
      hit.g.notes = hit.g.notes.filter(n => n !== hit.item);
      store.save();
      repaint();
      emit('change', { action: 'remove', item: hit.item });
    },
    // Put removed notes back, for an undo. Each item is what items() handed out,
    // a copy carrying target_id; it returns to its group in id order.
    restore(items) {
      let changed = false;
      for (const it of items || []) {
        const { target_id: targetId, ...note } = it;
        const g = store.group(targetId ?? PAGE);
        if (g.notes.some(n => n.id === note.id)) continue;
        g.notes.push(note);
        g.notes.sort((a, b) => a.id - b.id);
        changed = true;
      }
      if (!changed) return false;
      store.save();
      repaint();
      emit('change', { action: 'restore' });
      return true;
    },
    // purely visual, like openRequest: the marker a list row is hovering, and
    // the marker whose newest request is running
    highlight: id => noteSurface.setHot(id ?? null),
    working: id => noteSurface.setWorking(id ?? null),
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
    // ---------- requests ----------
    // Declarative and idempotent: the list REPLACES the previous declaration.
    // Safe before hydration, because it writes nothing — an answer that arrives
    // milliseconds later simply lights up a chip that is already on screen.
    setRequests(list) {
      requests = (list || []).filter(spec => spec && spec.key).map(spec => {
        const node = spec.el || (spec.selector ? document.querySelector(spec.selector) : null);
        return {
          key: spec.key,
          ask: spec.ask || '',
          // the live node, so a declared request never depends on a css path;
          // `target` is for the export and for re-finding it after a re-render
          node: node || null,
          target: node ? describeEl(node) : (spec.selector ? { selector: spec.selector } : null),
        };
      });
      tries = 0;
      settle();
      emit('change', { action: 'requests' });
      return requests.map(requestView);
    },
    requests: () => requests.map(requestView),
    orphans,
    // purely visual: rings the chip whose question is on screen right now
    openRequest: key => noteSurface.setOpenRequest(key ?? null),
    // '' clears the answer. That is the only path that deletes one, and it is
    // always a thing the reviewer clicked.
    answer(key, text) {
      const i = requests.findIndex(r => r.key === key);
      const r = i >= 0 ? requests[i] : null;
      const before = r ? requestView(r, i) : null;
      const said = text ?? '';
      if (!said.trim()) {
        store.forgetAnswer(key);
      } else {
        const prev = store.answer(key);
        store.setAnswer(key, {
          said,
          // an orphan being edited keeps the question it was originally asked
          q: r ? r.ask : (prev ? prev.q : ''),
          at: new Date().toISOString(),
        });
      }
      store.save();
      const view = r ? requestView(r, i) : { key, ask: null, answer: said.trim() ? said : '', answered: !!said.trim(), orphaned: true };
      // A chip shows a number, a tick, or a stale ring. Nothing else about it
      // depends on the answer's text, so editing one need not re-measure every
      // marker on the page — which is what makes writing on each keystroke cheap.
      // An orphan has no chip at all.
      if (before && (before.answered !== view.answered || before.stale !== view.stale)) noteSurface.layout();
      emit('change', { action: 'answer', request: view });
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
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll);
      if (unloadGuard) window.removeEventListener('beforeunload', unloadGuard);
      noteSurface.destroy();
      drawSurface.destroy();
      ink.destroy();
      emit('change', { action: 'destroy' });
    },
  });

  // A gesture is impossible until the stored feedback has landed. A note made
  // against the empty pre-hydration store either persists an empty blob over the
  // real one or has to be renumbered on top of it, and a few milliseconds of an
  // inert overlay beats both. The user has to click NOTES first anyway, which
  // takes far longer than the read.
  function applyMode() {
    noteSurface.setActive(loaded && mode === 'note');
    drawSurface.setActive(loaded && mode === 'draw');
  }

  // scene canvases and swapped-in panels are built after this module runs:
  // retry until every note's element resolves. Runs again on load, because the
  // first pass sees an empty store and so never schedules a retry.
  let tries = 0;
  function settle() {
    if (destroyed) return;
    repaint();
    // a request also counts as pending while its element has no box: it resolves,
    // but a chip cannot be placed on it yet (a panel that opens later, artwork
    // that has not sized itself)
    const boxless = r => {
      const el = (r.node && r.node.isConnected) ? r.node : resolve(r.target);
      if (!el) return true;
      const b = el.getBoundingClientRect();
      return !b.width && !b.height;
    };
    const pending = [...store.state.targets].some(([, g]) => g.notes.some(n => n.target && !resolve(n.target)))
      || requests.some(boxless);
    if (tries++ < 20 && pending) setTimeout(settle, 500);
  }
  settle();

  return pen;
}

export { describe };
