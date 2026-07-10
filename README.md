# redpen

Page review tools for leaving structured feedback on any HTML page, built to hand
that feedback to an agent as JSON. Three modules, one floating hub:

- **notes** — click an element to pin a note to it (selector, tag/id/classes, text,
  ancestors). Drag a box to select an area: every element mostly inside the box is
  captured, anchored to their common ancestor. A drag that starts on a graphic
  (canvas/img/video/svg) and stays inside it marks a region of that graphic instead,
  stored as 0-1 fractions of its box.
- **draw** — freehand ink overlay with lazy-brush smoothing and cmd+Z undo. Strokes
  anchor to an `#frame` element when the page has one, else to the document, so they
  stay glued to content while scrolling.
- **feedback-hub** — the bottom-right bar: one toggle pill + clear button per tool,
  include-checkboxes, and COPY JSON, which puts every tool's data on the clipboard
  in one block. Only one tool is active at a time.

Everything persists to localStorage per page. All injected UI is marked
`data-la-ui` (so the tools ignore their own chrome) and `sap-ignore` (so Sap-powered
pages leave it alone).

## Using it

On a served page (modules):

```html
<script type="module" src="./notes.js"></script>
<script type="module" src="./draw.js"></script>
```

On a `file://` page (modules are blocked there), use the bundle:

```html
<script src="../redpen/dist/redpen.js"></script>
```

Console handles: `NotesTool`, `DrawTool`, `FeedbackHub` (e.g. `FeedbackHub.json()`).

## Build

`dist/redpen.js` is a checked-in IIFE bundle of `src/index.js`. After editing `src/`:

```bash
npm run build
```

## Consumers

- `experiments/homepage-illustrations/` — `notes.js`, `draw.js`, `feedback-hub.js`
  there are symlinks into this repo's `src/`; scene pages import them as modules
  (notes via the `lineart.js` import, draw via its own script tag).
- `freelance-rate-calculator-app/index.html` — loads `dist/redpen.js` through a
  guarded loader that only runs on `file:` or localhost.

## JSON shape

```json
{
  "file": "index.html",
  "notes": {
    "coords": "region = fractions 0-1 of the target element box; area items also list the elements selected inside",
    "items": [
      { "id": 1, "note": "wrong verb", "type": "element",
        "target": { "selector": "section.hero > h2", "tag": "h2", "text": "Your break-even rate", "ancestors": [] } },
      { "id": 2, "note": "cramped", "type": "area",
        "target": { "selector": "section.results", "tag": "section" },
        "rect": { "w": 720, "h": 480 },
        "region": { "x": 0.08, "y": 0.31, "w": 0.52, "h": 0.28 },
        "elements": [ { "selector": "section.results > h2", "tag": "h2", "text": "…" } ] },
      { "id": 3, "note": "smudge here", "type": "region",
        "target": { "selector": "#gl", "tag": "canvas" },
        "rect": { "w": 560, "h": 373 },
        "region": { "x": 0.4, "y": 0.2, "w": 0.1, "h": 0.15 } }
    ]
  },
  "draw": { "coords": "px from document top-left", "strokes": [] }
}
```

Area items cap at 15 elements; a `truncated` count reports anything dropped.
Elements inside position-fixed overlays (floating chips, toasts) are flagged
`"fixed": true` and never pick the note's anchor.
