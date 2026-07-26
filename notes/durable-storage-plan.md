# Plan: redpen stops losing notes when storage fills up

**✅ SHIPPED 2026-07-26** — built, dual-reviewed, review findings fixed and verified against
pre-fix control bundles. Pushed as `67548f6`.

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

**Nothing is written before hydration, and no gesture is possible before it either.** The first
cut tried to rescue notes made in that window by renumbering them above the stored counter. Both
reviewers found that rescue is where the data loss lives (see below), so the window is closed
instead: the store refuses to write until the read lands, and the note and draw surfaces stay
inactive until then. The user has to click NOTES first, which takes far longer than the read, so
the window is unreachable in practice rather than merely unlikely.

**A read that fails is not a store that is empty.** If IndexedDB cannot be read, redpen neither
adopts the stale localStorage copy nor writes anything: the store goes read-only and reports it
through the same channel a failed write uses. Overwriting a store you could not read is how one
transient abort becomes permanent loss.

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

## What the review changed

Two independent reviews ran on the first cut (a Claude reviewer and a Codex reviewer, both
read-only). Both landed on the same root cause wearing three different hats: **the store accepted
mutations while it was still empty.** Three data-loss paths followed from it.

1. A note made before hydration persisted a one-note blob **over ten stored ones**. The queued
   snapshot committed after the read restored the old data, erasing it.
2. A `clear()` in that window undid itself: hydration put the cleared notes back on screen while
   the queued empty snapshot erased them durably.
3. A **failed** IndexedDB read fell through to the stale localStorage copy and wrote it over newer
   IndexedDB data. One transient abort, permanent loss.

The fix is the window closing, not four patches. `drain()` and `rescue()` were deleted outright,
which also took two lesser findings with them (rescue renumbered ids the host had already been
told about, and a drained group lost its coordinate `basis`). Also fixed: `normalizeOnce` was
firing against the empty pre-hydration store, so legacy `la-draw:` pixel strokes were never being
converted to fractions; `settle()` scheduled no retries because it saw an empty store, and now
re-runs on load; `onSaveError` honours `destroyed`, so a write that rejects after `destroy()` can
no longer arm an unload guard nothing is left to remove; a panel attached after a failure starts
red; and a connection that opens late after `onblocked` is closed rather than leaked.

**Verified against pre-fix control bundles**, so every bug was proven to reproduce before being
proven fixed. Forced hydration race: stored and memory agree at 10 notes (control stored 1, lost
10). Forced read failure: IndexedDB byte-identical at 5 notes, panel red, no write attempted
(control overwrote with the 1 stale note). Legacy px strokes normalize again (`px` gone,
fractional points). Destroy during a failed write leaves `defaultPrevented === false`. claylines
untouched: selftest 58/58, parity 0 differing pixels across 1311 samples.

## Known open

- **A final keystroke can be lost on tab close.** localStorage committed synchronously; an
  IndexedDB transaction does not. Typing in a note field and immediately closing the tab can drop
  the last few characters. Everything already committed is safe. Fixable with a `pagehide`
  best-effort flush if it ever actually bites.
- **Multi-tab is last-write-wins on the whole blob.** Two tabs on the same key each write
  everything, so the loser's changes are gone. Unchanged from the localStorage behaviour it
  replaces, and not made worse by this change.
