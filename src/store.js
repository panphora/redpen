// store.js — v3 persistence for one redpen instance: one blob under the instance
// key, feedback grouped by target, notes and strokes sharing one id counter so an
// agent can be told "fix stroke 4 on p12".
//
//   { v: 3, counter: 42,
//     answers: { 'ask-also': {said:'keep it struck', q:'…', at:'2026-08-04T…'} },
//     targets: {
//       p19: { basis: {type:'viewbox', viewBox:[0,0,1000,820]},
//              notes:   [ {id:16, text:'…', kind:'region', box:{x:388,y:600,w:250,h:60}} ],
//              strokes: [ {id:17, points:[[392,612], …], width:3} ] } } }
//
// `answers` is the reply side of a review request. Requests themselves are never
// stored: the page declares them on every load, so the HTML is the truth about
// which questions exist and there is nothing to reconcile. An answer carries the
// question it was replying to, which is what lets a reworded or deleted question
// leave a readable answer behind instead of an orphaned string.
//
// Geometry is stored in the target's own basis: viewbox user units for panels,
// fractions 0-1 for the page. Legacy `la-notes:<path>` / `la-draw:<path>` fold
// into the `page` target on first load. Old draw pixels have no fraction basis
// of their own, so they keep `px: true` until the first layout that has a real
// box to normalize against — nothing is silently discarded.

import { PAGE } from './targets.js';
import { createBackend } from './backend.js';

const r1 = n => Math.round(n * 10) / 10;
const r4 = n => Math.round(n * 10000) / 10000;

export function createStore({ key, storage, backend: given, onLoad, onSaveError }) {
  const legacyNotesKey = 'la-notes:' + key;
  const legacyDrawKey = 'la-draw:' + key;
  const backend = given ?? createBackend({ key, storage });

  // null-prototype: an answer is keyed by an element id the page chose, and on a
  // plain object an id of `constructor` or `toString` reads back as an inherited
  // value, so a question nobody touched would render as already answered
  const state = { counter: 0, targets: new Map(), answers: Object.create(null) };

  // An answer cleared before the read landed has nothing in `answers` to stand
  // for it, so the merge below would restore the very answer that was just
  // deleted. The clear is remembered instead, and applied after the blob.
  const clearedBeforeLoad = new Set();

  function group(id) {
    let g = state.targets.get(id);
    if (!g) { g = { notes: [], strokes: [], basis: null }; state.targets.set(id, g); }
    return g;
  }

  function adoptBlob(blob) {
    if (!blob || blob.v !== 3) return false;
    state.counter = blob.counter || 0;
    // memory wins: an answer typed in the few ms before the read landed is newer
    // than the stored one, and adopting the blob wholesale would erase it
    if (blob.answers) {
      state.answers = Object.assign(Object.create(null), blob.answers, state.answers);
      // an answer edited before the read landed had no way to know what question
      // it was replying to, so the stored one fills the gap rather than being
      // overwritten with nothing
      for (const [key, mem] of Object.entries(state.answers)) {
        if (!mem.q && blob.answers[key]) mem.q = blob.answers[key].q;
      }
      for (const key of clearedBeforeLoad) delete state.answers[key];
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

  // ---------- legacy migration ----------

  function migrateLegacy() {
    const page = group(PAGE);
    page.basis = { type: 'fraction' };
    let found = false;

    let saved = null;
    try { saved = JSON.parse(storage.getItem(legacyNotesKey) || 'null'); } catch {}
    if (saved) {
      // v1 ({annos, counter}) came from the scene pages, where regions were
      // fractions of the 560x373 #gl canvas
      const items = saved.v === 2
        ? (saved.items || [])
        : (saved.annos || []).map(a => ({
            id: a.id, note: a.note, type: 'region',
            target: { selector: '#gl', tag: 'canvas' },
            rect: { w: 560, h: 373 },
            region: { x: a.x, y: a.y, w: a.w, h: a.h },
          }));
      for (const it of items) {
        page.notes.push({
          id: it.id,
          text: it.note || '',
          kind: it.type,
          target: it.target,
          ...(it.region ? { box: { ...it.region } } : {}),
          ...(it.rect ? { rect: it.rect } : {}),
          ...(it.elements ? { elements: it.elements } : {}),
          ...(it.truncated ? { truncated: it.truncated } : {}),
        });
        found = true;
      }
      state.counter = Math.max(state.counter, saved.counter || 0, ...page.notes.map(n => n.id || 0));
    }

    let legacyStrokes = null;
    try { legacyStrokes = JSON.parse(storage.getItem(legacyDrawKey) || 'null'); } catch {}
    if (Array.isArray(legacyStrokes)) {
      for (const s of legacyStrokes) {
        if (!Array.isArray(s) || !s.length) continue;
        page.strokes.push({ id: ++state.counter, points: s.map(([x, y]) => [x, y]), width: 3, px: true });
        found = true;
      }
    }
    return found;
  }

  // Old draw points are px offsets from #frame (or the document); once there is
  // a real box to measure against they become fractions like everything else.
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

  // ---------- hydration ----------
  // IndexedDB is async, so the store starts EMPTY and fills a few milliseconds
  // later. Nothing may be written before that lands: a write from the empty
  // window commits an empty blob over the stored one, which is how a single
  // note made too early destroyed ten stored ones. The engine keeps its pointer
  // surfaces switched off until `loaded` for the same reason, so there is no
  // window in which a gesture can be made against the wrong state.

  let loaded = false;
  let readFailed = false;

  (async function hydrate() {
    let blob = null;
    try {
      blob = await backend.read();
    } catch (err) {
      // A read that FAILED is not a store that is empty. We do not know what is
      // in there, so we neither adopt nor overwrite: the store goes read-only
      // and says so, loudly, through the same channel a failed write uses.
      readFailed = true;
      onSaveError?.(err);
    }
    const migrated = !readFailed && !adoptBlob(blob) && migrateLegacy();
    loaded = true;
    onLoad?.({ migrated, readFailed });
    flush();
  })();

  // ---------- writing ----------
  // One write in flight with the state serialized at flush time, not at save
  // time: a blob snapshotted before hydration would otherwise be committed
  // after it, erasing everything the read had just restored.

  let dirty = false, writing = false;

  function flush() {
    // never before hydration (an empty blob would erase the stored one), and
    // never after a failed read (we would be overwriting we-don't-know-what)
    if (writing || !dirty || !loaded || readFailed) return;
    dirty = false;
    writing = true;
    backend.write(toJSON()).then(
      () => { writing = false; flush(); },
      err => { writing = false; onSaveError?.(err); flush(); },
    );
  }

  function toJSON() {
    const targets = {};
    for (const [id, g] of state.targets) {
      if (!g.notes.length && !g.strokes.length) continue;
      targets[id] = {
        ...(g.basis ? { basis: g.basis } : {}),
        notes: g.notes,
        strokes: g.strokes.map(s => ({
          id: s.id,
          points: s.points.map(([x, y]) => (s.px ? [r1(x), r1(y)] : [r4(x), r4(y)])),
          width: s.width,
          ...(s.px ? { px: true } : {}),
        })),
      };
    }
    const answers = Object.keys(state.answers).length ? { answers: state.answers } : {};
    return { v: 3, counter: state.counter, ...answers, targets };
  }

  // Resolves once nothing is waiting to be written. `flush` chains itself, so a
  // promise taken mid-write settles after the LAST write rather than the one in
  // flight. Polling the two real flags beats any bookkeeping here: there is no
  // waiter list to leak, and no path that can forget to settle it.
  function flushed() {
    return new Promise(resolve => {
      const tick = () => (writing || dirty ? setTimeout(tick, 0) : resolve());
      tick();
    });
  }

  return {
    state,
    group,
    loaded: () => loaded,
    flushed,
    answer: key => state.answers[key] || null,
    setAnswer(key, record) {
      state.answers[key] = record;
      clearedBeforeLoad.delete(key);
    },
    forgetAnswer(key) {
      delete state.answers[key];
      if (!loaded) clearedBeforeLoad.add(key);
    },
    answerKeys: () => Object.keys(state.answers),
    normalizePixelStrokes,
    nextId: () => ++state.counter,
    save() {
      dirty = true;
      flush();
    },
    toJSON,
  };
}
