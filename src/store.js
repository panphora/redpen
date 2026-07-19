// store.js — v3 persistence for one redpen instance: one blob under the instance
// key, feedback grouped by target, notes and strokes sharing one id counter so an
// agent can be told "fix stroke 4 on p12".
//
//   { v: 3, counter: 42,
//     targets: {
//       p19: { basis: {type:'viewbox', viewBox:[0,0,1000,820]},
//              notes:   [ {id:16, text:'…', kind:'region', box:{x:388,y:600,w:250,h:60}} ],
//              strokes: [ {id:17, points:[[392,612], …], width:3} ] } } }
//
// Geometry is stored in the target's own basis: viewbox user units for panels,
// fractions 0-1 for the page. Legacy `la-notes:<path>` / `la-draw:<path>` fold
// into the `page` target on first load. Old draw pixels have no fraction basis
// of their own, so they keep `px: true` until the first layout that has a real
// box to normalize against — nothing is silently discarded.

import { PAGE } from './targets.js';

const r1 = n => Math.round(n * 10) / 10;
const r4 = n => Math.round(n * 10000) / 10000;

export function createStore({ key, storage }) {
  const blobKey = 'redpen:' + key;
  const legacyNotesKey = 'la-notes:' + key;
  const legacyDrawKey = 'la-draw:' + key;

  const state = { counter: 0, targets: new Map() };

  function group(id) {
    let g = state.targets.get(id);
    if (!g) { g = { notes: [], strokes: [], basis: null }; state.targets.set(id, g); }
    return g;
  }

  function readBlob() {
    let blob = null;
    try { blob = JSON.parse(storage.getItem(blobKey) || 'null'); } catch {}
    if (!blob || blob.v !== 3) return false;
    state.counter = blob.counter || 0;
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

  const hadV3 = readBlob();
  const migrated = hadV3 ? false : migrateLegacy();
  group(PAGE);

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
    return { v: 3, counter: state.counter, targets };
  }

  return {
    state,
    group,
    migrated,
    normalizePixelStrokes,
    nextId: () => ++state.counter,
    save() {
      storage.setItem(blobKey, JSON.stringify(toJSON()));
    },
    toJSON,
  };
}
