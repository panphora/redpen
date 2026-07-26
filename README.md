# redpen

Page review tools for leaving structured feedback on any HTML page, built to hand
that feedback to an agent as JSON.

redpen is a **headless engine** plus a **default UI adapter**, shipped as two bundles:

- `dist/redpen.js` — engine + default UI. The standalone experience: the bottom-right
  hub bar, the `#laNotes` panel, global cmd+Z, and the `NotesTool` / `DrawTool` /
  `FeedbackHub` console handles.
- `dist/redpen-core.js` — the engine alone, as `window.Redpen.create(...)`. Zero
  chrome, no global keyboard, no clipboard. The host owns all of that.

## What the engine does

- **notes** — click an element to pin a note to it (selector, tag/id/classes, text,
  ancestors). Drag a box to select an area: every element mostly inside the box is
  captured, anchored to their common ancestor. A drag that starts on a graphic
  (canvas/img/video/svg) and stays inside it marks a region of that graphic. A tap on
  a pixel graphic (canvas/img/video) drops a pinpoint at the exact spot instead; svg
  keeps the element note, because there the tapped shape has a name worth recording.
- **draw** — freehand ink with lazy-brush smoothing. Ink binds to the target it
  started in and never rebinds, so a stroke may overshoot the panel edge and still
  belong to that panel.
- **targets** — a target is a first-class registered thing (`{id, selector|el, basis}`).
  A panel is a target; any marked element can be a target. Feedback is keyed by
  target id, and `show(id)` is the one call on panel switch.

Headless means no chrome, not no rendering: the engine still injects the capture
overlay, the hover box, the numbered markers, the ink canvas and the per-target SVG
ink overlays into `mount`. Those are the feedback medium. All injected UI is marked
`data-la-ui` (so the tools ignore their own chrome) and `sap-ignore` (so Sap-powered
pages leave it alone).

## Note context (the page enriches its own notes)

A note is only reproducible if it carries the state it was made in. redpen does not
know what that state is, so it asks: on every note it walks from the annotated
element up to `<html>` and collects a contribution from each ancestor, then stores
and exports it verbatim under `note.context`. redpen interprets none of it.

Two ways to contribute, both found by the same walk:

```js
// dynamic — called at note-creation, handed the gesture
mount.redpenContext = info => ({ myApp: { route: location.pathname, t: clock.now() } });
```

```html
<!-- static — a plain HTML page enriches its own notes with no script at all -->
<div data-redpen-context='{"myApp":{"build":"a41"}}'>…</div>
```

`info` is `{ kind, x, y, box, targetId }`: `kind` is the note kind, `x`/`y` the
gesture point in client px, `box` the gesture rect `{x, y, w, h}` in client px for a
region or an area (null for a tap or a point), `targetId` the registered target the
gesture bound to.

Namespace your payload under a key you own. The merge is one level deep and runs
outermost first, so an inner provider replaces an outer one's namespace wholesale
rather than merging into it. A provider that throws costs its own contribution and
nothing else.

Storage keys: the default is `location.pathname`. A host whose pages differ only by
query string sets `window.REDPEN_KEY` before loading `dist/redpen.js` (or passes
`key` to `Redpen.create`) so each subject gets its own notes blob.

## Coordinate bases

A target declares one of two bases, and every note box and stroke point is stored
in it:

- `{type:'viewbox', viewBox:[0,0,1000,820]}` — the SVG's own user units, the same
  coordinates the artwork is authored in, so an agent handed the feedback can turn
  "move the left eye down" into a data edit near-directly. Screen ⟷ basis goes
  through `getScreenCTM()`, so it is exact under any `preserveAspectRatio`,
  DPR-proof and robust to letterboxing.
- `{type:'fraction'}` — fractions 0-1 of the element's box. This is the region-note
  model redpen has always used; the default `page` target uses it.

## Using it

Headless, on a host that owns its own UI:

```js
const pen = Redpen.create({
  key: 'la:' + location.pathname,  // storage namespace (default: location.pathname)
  mount: document.getElementById('stage'),
  storage: localStorage,           // injectable; file://-safe
  identify: el => describe(el),    // optional
});

pen.addTarget({ id: 'p19', selector: '#p19', basis: { type: 'viewbox', viewBox: [0, 0, 1000, 820] } });
pen.addEventListener('change', e => renderList(e.detail));
pen.setMode('note');
pen.show('p19');   // the one call on panel switch
```

Events: `change` `{action, item?}` · `item:add` `{item}` · `mode` `{mode}` ·
`target` `{target}` · `layout` (markers were re-placed).

Methods: `setMode(mode)` `mode()` `items(targetId?)` `strokes(targetId?)`
`setNote(id, text)` `remove(id)` `undoStroke(targetId?)` `clear(targetId?)`
`clearNotes(targetId?)` `clearStrokes(targetId?)` `data(targetId?)` `layout()`
`destroy()` · `addTarget({id, selector|el, basis})` `removeTarget(id)`
`targets()` `show(targetId|null)` `target()`.

The engine binds **no** global keyboard and **no** clipboard. It exposes
`undoStroke()`; the host routes keys and owns COPY.

Standalone, on a served page (modules):

```html
<script type="module" src="./notes.js"></script>
<script type="module" src="./draw.js"></script>
```

On a `file://` page (modules are blocked there), use the bundle:

```html
<script src="../redpen/dist/redpen.js"></script>
```

Console handles: `NotesTool`, `DrawTool`, `FeedbackHub` (e.g. `FeedbackHub.json()`).

## Source layout

```
store.js         v3 blob: notes + strokes per target, one shared id counter, legacy migration
targets.js       the target registry and the two coordinate bases (getScreenCTM / fractions)
identify.js      cssPath / describe / resolve / nthOfType
note-surface.js  capture overlay + markers + rubber-band drag + region/area capture
draw-surface.js  ink canvas + lazy brush + smoothing + RDP + SVG path export
ink-layer.js     finished strokes as SVG marks in one overlay <svg> per viewbox target
engine.js        Redpen.create → RedpenEngine extends EventTarget
ui.js            default adapter: hub bar + #laNotes list + global cmd+Z
standalone.js    composes engine + ui into one page-wide instance
index.js         engine + ui   → dist/redpen.js
index-core.js    engine alone  → dist/redpen-core.js
notes.js / draw.js / feedback-hub.js
                 import-and-go entry points kept for the scene pages that symlink them
```

## Storage

One blob per instance key, `redpen:<key>`:

```json
{ "v": 3, "counter": 42,
  "targets": {
    "p19": { "basis": { "type": "viewbox", "viewBox": [0, 0, 1000, 820] },
             "notes":   [ { "id": 16, "text": "…", "kind": "region", "box": { "x": 388, "y": 600, "w": 250, "h": 60 } } ],
             "strokes": [ { "id": 17, "points": [[392, 612]], "width": 3 } ] } } }
```

Notes and strokes share one counter, so an agent can be told "fix stroke 4 on p12".
Legacy `la-notes:<path>` / `la-draw:<path>` fold into the `page` target on first
load; the old keys are left in place. Old draw pixels keep a `px` flag until the
first layout with a real box to normalize against, so nothing is silently discarded.

## Build

`dist/redpen.js` and `dist/redpen-core.js` are checked-in IIFE bundles. After
editing `src/`:

```bash
npm run build
```

## Test

`test/two-target.html` is a dependency-free fixture: two `viewBox="0 0 1000 820"`
SVGs side by side, each registered as a viewbox target, loaded with
`dist/redpen-core.js`. Open it from `file://` and use the buttons to exercise
show-filtering, overshoot binding, resize, persistence and `data()`.

## Consumers

- `experiments/homepage-illustrations/` — `notes.js`, `draw.js`, `feedback-hub.js`
  there are symlinks into this repo's `src/`; scene pages import them as modules
  (notes via the `lineart.js` import, draw via its own script tag).
- `freelance-rate-calculator-app/index.html` — loads `dist/redpen.js` through a
  guarded loader that only runs on `file:` or localhost.

## JSON shape

`COPY JSON` (and `pen.data()`) group by target, and each target states its own
coordinate rule:

```json
{
  "file": "index.html",
  "targets": {
    "p19": {
      "basis": "viewbox",
      "coords": "note boxes and stroke paths are in the target SVG's own user units (its viewBox), …",
      "viewBox": [0, 0, 1000, 820],
      "notes": [
        { "id": 1, "text": "eye sits too high", "kind": "region",
          "box": { "x": 388, "y": 600, "w": 250, "h": 60 } }
      ],
      "strokes": [
        { "id": 2, "d": "M 392 612 L 470 640 Z", "bbox": [392, 612, 78, 28], "closed": true, "width": 3 }
      ]
    },
    "page": {
      "basis": "fraction",
      "coords": "note boxes are fractions of the target element box … stroke paths are integer px in the stated viewBox; …",
      "viewBox": [0, 0, 1280, 577],
      "notes": [
        { "id": 3, "text": "wrong verb", "kind": "element",
          "target": { "selector": "section.hero > h2", "tag": "h2", "text": "Your break-even rate" } }
      ],
      "strokes": []
    }
  }
}
```

Fraction-basis stroke paths are projected back into the target's current pixel box
so the exported `d` stays readable px. Area items cap at 15 elements; a `truncated`
count reports anything dropped. Elements inside position-fixed overlays (floating
chips, toasts) are flagged `"fixed": true` and never pick the note's anchor.
