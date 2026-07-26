# Plan: redpen stops losing notes when storage fills up

**Decided 2026-07-26** via the questions form. All eight answers are locked; seven took the
recommendation, one did not: **storage moves to IndexedDB** rather than staying on the single
localStorage blob.

## The problem

`store.save()` is `storage.setItem(key, JSON.stringify(toJSON()))`, unguarded, and redpen rewrites
its whole blob on every note, keystroke and stroke. localStorage is a few megabytes per **origin**,
shared with whatever else that origin stores. When it fills, `setItem` throws, the note lives only
in memory, and nothing tells anyone. Every later save throws too. This is the same silent-loss
shape we just fixed for unserializable context payloads, arriving by a different door, and beat
notes now carry ~700 bytes of context each, which brings the door closer.

## The decisions

| Question | Answer |
|---|---|
| On failure | Keep the note, warn loudly |
| How you find out | Persistent red state in the notes panel |
| Auto-rescue | No, just warn |
| Context size cap | No cap for now |
| Reload guard | Only after a save has failed |
| Storage design | **Move to IndexedDB** |
| Where it lives | redpen, for every consumer |
| When | Now |

## Verified before designing

- **IndexedDB works from `file://`** in Chrome. Probed directly: `indexedDB.open` on a
  `file://` page resolved `OPEN OK`. redpen's README promises file:// support, so this was the one
  thing that could have invalidated the decision. It did not. Safari is stricter, which is one
  reason the synchronous fallback below stays.

## Design

**IndexedDB first, the injected synchronous storage second.** A browser with IDB disabled, a
private window, or an `open()` that throws falls back to localStorage and behaves exactly as
redpen always did. This keeps the `storage` injection contract (tests inject a fake) meaningful.

**The store hydrates rather than loads.** IDB is async, so `createStore` can no longer have the
data at construction. It starts empty and fills in a few milliseconds later, then repaints and
emits. This is the one visible consequence: `pen.items()` and `pen.data()` return empty for a
moment after `create()`. In practice nothing is affected, because redpen's own panel renders off
the `change` event and the engine already runs a `settle()` repaint loop for exactly this reason.
A new `change` action, `load`, marks the moment.

**Notes made during that window are rescued, not dropped.** Vanishingly rare (the tool starts
switched off), but if any exist when the stored blob lands they are re-numbered above the stored
counter and appended, so ids can never collide.

**Writes coalesce.** One write in flight at a time with the latest state pending, so holding down
a key in a note field does not queue a hundred transactions.

**Failure is loud and sticky.** The engine emits `save:error`; the default panel turns red and
stays red for the session with a line telling you to COPY JSON; a `beforeunload` guard arms only
after the first failure. COPY JSON reads memory, so everything is still recoverable.

**Migration is non-destructive.** The first read after this change adopts an existing
`redpen:<key>` localStorage blob into IDB and **leaves the original in place**, so an older build
still opens it. The legacy v1/v2 (`la-notes:` / `la-draw:`) migration is unchanged.

## Blast radius

`redpen/src/`: new `backend.js`; `store.js` rewritten around it; `engine.js` gains the failure
state, the `save:error` event and the unload guard; `ui.js` gains the red panel state. Both bundles
rebuild. Every page using redpen is affected, which is the point (the answer was "for every
consumer"). No consumer API is removed; one is added (`pen.saveFailed()`).

## Not doing

- No context size cap (answered).
- No auto-copy to clipboard (answered).
- No eviction of old notes. If storage is full the user is told; redpen never silently discards
  someone's feedback.
- The stale localStorage blob is not deleted. It stops growing, and keeping it means a rollback
  loses nothing.
