# redpen

Page review tools for leaving structured feedback on any HTML page, built to hand
that feedback to an agent as JSON.

redpen is a **headless engine** plus **UI adapters**, shipped as four bundles:

- `dist/redpen.js`: engine + the dock. The standalone experience, one adapter per
  page, plus the `NotesTool` / `DrawTool` / `FeedbackHub` console handles.
- `dist/redpen-core.js`: the engine alone, as `window.Redpen.create(...)`. Zero
  chrome, no global keyboard, no clipboard. The host owns all of that.
- `dist/redpen-review.js`: engine + the dock as a mountable adapter,
  `window.RedpenReview.mount(...)`. The same UI, created and destroyed when the host
  says so, and able to answer questions the page asks about itself. See
  [Requests](#requests).
- `dist/redpen-wire.js`: the transport, `window.RedpenWire.attach(review)`. Hands a
  finished comment to an agent over `clay.wire` and brings the reply back. See
  [The thread](#the-thread).

## Comment on a page and have an agent edit it

This section is for using redpen, not building on it. You open an HTML file, click a phrase, write what should change, and send it. An AI agent on your computer edits the file, the page updates in place, and the agent's answer appears under your comment. You can reply to continue.

You need:

- [HTML Clay](https://htmlclay.com), which opens the file and connects it to a program on your computer.
- An AI agent you can run from the terminal. The example uses [Claude Code](https://claude.com/claude-code): `claude --version` should print a version number.
- Python 3.

**1. Add redpen to the page.** Put these lines at the end of the file's `<body>`:

```html
<script src="https://clayjs.com/v1/clay.js?plugins=sync,wire"></script>
<script src="https://cdn.jsdelivr.net/gh/panphora/redpen@main/dist/redpen-review.js"></script>
<script src="https://cdn.jsdelivr.net/gh/panphora/redpen@main/dist/redpen-wire.js"></script>
<script>RedpenReview.mount({});</script>
```

Keep that order. Save the file with the `.htmlclay` extension.

**2. Get the agent program.** Download [`examples/claude-agent.sh`](examples/claude-agent.sh) and save it next to the page. It hands your comment to Claude Code, prints "thinking" while the agent works, and sends back what it says.

**3. Connect them.** On macOS, make the `htmlclay` command available in this terminal first:

```sh
alias htmlclay="/Applications/HTMLClay.app/Contents/MacOS/htmlclay"
```

Then start the connection and leave it running:

```sh
htmlclay wire serve page.htmlclay -- bash claude-agent.sh
```

**4. Comment.** Double click `page.htmlclay`. The redpen dock sits in the bottom right corner. Press `C`, click the phrase you want changed, write the change, and click outside the box. The comment sends, the dock's wire dot fills while the agent works, and the page updates when it is done. A small change usually takes fifteen seconds to a minute.

Things to know:

- **The agent runs as you.** It can read and change any file you can, in the folder you started it from. `--permission-mode acceptEdits` in the script lets it edit without asking about each change. Use a stricter mode if you want to approve each one.
- **Your file goes to the agent's provider**, under your account with them. HTML Clay and redpen send it nowhere.
- **One comment at a time.** A comment you send while the agent is working waits its turn, and sends when the agent finishes. Keep the page open in one tab only: two tabs can run two agents on the same file, and one edit can overwrite the other.
- **No agent running?** Comments stay on the page, stored in your browser. **Copy JSON** in the dock copies them all, ready to paste into any agent.

Stop the connection with Ctrl+C. The rest of this README is the reference for building on redpen.

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

## Where feedback lives

Feedback is stored in **IndexedDB**, one blob per instance key, under the `redpen` database.
localStorage is the fallback for browsers where IndexedDB is unavailable (private windows, some
`file://` contexts), and the `storage` option injects it.

localStorage used to be the only home, and it is a few megabytes per **origin** shared with
everything else the page stores. redpen rewrites its whole blob on every note, so a full one made
`setItem` throw and every later write failed too, silently. IndexedDB has a much larger budget and
reports failure per write.

Two consequences worth knowing:

- **The store hydrates asynchronously.** `create()` returns immediately with an empty store and
  fills a few milliseconds later, then emits `change` with `action: 'load'`. Render off the events
  rather than reading `items()` once at construction. Nothing is written before that lands, and the
  note and draw surfaces stay inactive until it does, so a gesture can never be made against the
  empty store. Host calls that mutate (`clear()`, `setNote()`) should wait for `load` too.
- **A failed read makes the store read-only.** If IndexedDB cannot be read, redpen does not assume
  it is empty and does not write: it emits `save:error` and keeps everything in memory, because
  overwriting a store you could not read is how one transient error becomes permanent loss.
- **A failed write is announced, not swallowed.** The engine emits `save:error`, `pen.saveFailed()`
  stays true, the default panel turns red for the rest of the session, and a `beforeunload` guard
  arms. Notes stay in memory and still export, so COPY JSON always recovers them.

An existing `redpen:<key>` localStorage blob is adopted into IndexedDB on first read and **left in
place**, so rolling back to an older build loses nothing.

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
  storage: localStorage,           // fallback only; IndexedDB is primary
  identify: el => describe(el),    // optional
});

pen.addTarget({ id: 'p19', selector: '#p19', basis: { type: 'viewbox', viewBox: [0, 0, 1000, 820] } });
pen.addEventListener('change', e => renderList(e.detail));
pen.setMode('note');
pen.show('p19');   // the one call on panel switch
```

Events: `change` `{action, item?}` · `item:add` `{item, sticky}` · `item:click`
`{item}` · `request:click` `{request}` · `mode` `{mode}` · `target` `{target}` ·
`layout` (markers were re-placed) · `save:error`.

Methods: `setMode(mode)` `mode()` `items(targetId?)` `strokes(targetId?)`
`setNote(id, text)` `updateNote(id, fn)` `updateNotes(fn)` `remove(id)`
`restore(items)` `undoStroke(targetId?)` `clear(targetId?)`
`clearNotes(targetId?)` `clearStrokes(targetId?)` `data(targetId?)` `review()`
`highlight(id?)` `working(id?)` `layout()`
`loaded()` `destroy()` · `addTarget({id, selector|el, basis})` `removeTarget(id)`
`targets()` `show(targetId|null)` `target()`.

The engine binds **no** global keyboard and **no** clipboard. It exposes
`undoStroke()`; the host routes keys and owns COPY.

### The dock

`dist/redpen.js` and `dist/redpen-review.js` put the same dock in the bottom-right
corner. It is the whole UI:

- **comment** and **draw**, the two mode toggles.
- a **stepper** (`2/6`), shown only when the page asks questions of its own.
- a **list** button carrying the number of open comments. It opens a panel of them,
  newest first, with a way through to the resolved ones and to answers whose
  question the page no longer asks.
- **⋯**, the menu: the three copy variants, whether comments send as you finish
  them, the shortcut card, whether an agent is connected, and clear-all for comments
  and for ink. Every destructive row confirms in place.
- a **wire dot**, present only when an agent is connected and filled while it works.
- **Copy JSON**, which shrinks to a `⧉` beside **Send** once an agent is connected.

Clicking an element in comment mode pins a numbered comment to it and opens a box on
the element itself. Leaving the box is what saves what you wrote, and what sends it
when an agent is connected and sending is not held; Escape backs out without sending.
Hovering a marker or a list row shows what it says without opening it.

| key | does |
|---|---|
| `C` | comment mode on / off |
| `D` | draw mode on / off |
| `Esc` | back out one step |
| `⌘↵` | done, or send a follow-up |
| `⌘Z` | undo the last stroke, in draw mode |
| `N` | next unanswered question, when the page asks any |
| `?` | the shortcut card |
| shift-click | place a comment and stay in comment mode |

Pass `keys: false` to `mount()` to bind none of them.

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

## Requests

A note is feedback going one way. A **request** is the page asking a question about
one of its own elements and getting an answer back. The agent writes the questions
into the HTML, one attribute on the element being asked about, and the element's id
is the answer's key:

```html
<span class="flag" id="ask-also" data-review-ask="Keep 'also' struck?">…</span>
```

```html
<script src="dist/redpen-review.js"></script>
<script>const review = RedpenReview.mount({ clickThrough: 'canvas.beat-video' });</script>
```

`mount` options: `key` (storage key, default `review:<pathname>`), `attr` (the question
attribute, default `data-review-ask`), and `clickThrough` — a selector for artwork the
page covers with `pointer-events: none`. Without it, a drag across such a picture files
an *area* note about the surrounding divs instead of a *region* note in fractions of the
picture, and the two look identical until the paste. It is applied as a stylesheet rule
so artwork mounted later (lazily, on scroll) is covered too.

A numbered chip appears at the end of each asked element, in its own
`pointer-events: auto` layer (`.laMarkers` is not clickable, by design, so note
markers never are). Clicking it opens a box with the question and a field. The dock
counts what is left, steps between unanswered questions, toggles comment mode, and
copies everything as one JSON blob.

**Requests are never persisted.** The page re-declares them on every load, so the
HTML is the truth about which questions exist: no migration, no reconciliation rule,
and no question that resurrects from storage after the author deleted it. Only the
answer is stored, and it stores the question it was answering:

```json
"answers": { "ask-also": { "said": "keep it struck", "q": "Keep 'also' struck?", "at": "2026-08-04T…" } }
```

That one extra field is what makes an edited page survivable. An answer whose
question was **reworded** is `stale`: the popover shows both versions and the export
carries `askedWas`. An answer whose question was **deleted** is `orphaned`: it is
counted in the bar, listed with the question it was replying to, and still exported.
Nothing here ever deletes an answer on its own — `answer(key, '')`, from a discard
click, is the only path that removes one.

Engine surface:

```js
pen.setRequests([{ key, ask, el?, selector? }])   // replaces the declaration; writes nothing
pen.requests()      // [{ key, n, ask, target, answer, answered, askedWas, stale }]
pen.orphans()       // stored answers the page no longer asks for
pen.answer(key, text)
pen.openRequest(key)   // visual only: rings that chip
pen.review()        // the flat export, answers and comments in one list
```

`request:click` fires when a chip is clicked. `review()` is separate from `data()`
on purpose: `data()` has live consumers and projects notes through a fixed field
whitelist, so anything new added there would be silently dropped.

## The thread

A comment can hold a conversation. You say something, an agent answers **in words**
and edits the file, and you answer that. The words live on the note; the edit does
not, and never touches redpen: it arrives as an ordinary external change to the
file, through live sync. A finished request and a visible change are two different
events, which is why the thread reports both.

```html
<script src="dist/redpen-review.js"></script>
<script src="dist/redpen-wire.js"></script>
<script>const review = RedpenReview.mount({});</script>
```

`mount()` attaches the transport itself when the bundle is there, so the only reason
to call `RedpenWire.attach(review)` by hand is `wire: false`. `attach` needs
`clay.wire`; without it every comment still lands in the clipboard through Copy JSON,
which is the ordinary shape of a review page with no agent.

### The seam

`thread.js` owns every piece of state, and `mount.js` wires it to the dock and the popover. The transport owns the live handles and
the translation in both directions, and creates **no DOM at all**.

```js
review.thread.connect(transport)     // → disconnect()
review.thread.send(noteId, text)     // → the turn, or null
review.thread.open(noteId)           // open that comment's popover
review.thread.of(noteId)             // a frozen copy, for hosts and tests
review.thread.resolve(noteId, on)    // retire a comment, or bring it back
review.thread.resume(noteId, turnId) // send a turn a reload left parked
review.thread.connected() / .busy()
```

```js
// what a transport implements
{ send(request) -> { id } | null, cancel(id) -> boolean, label, attach?(sink), detach?() }

// what thread.js hands it
{ state(id, state, error), progress(id, line), reply(id, text, { append }), note(id, line) }
```

`note` is the transport's own remark about an exchange, which is how a reply that
arrived broken becomes visible without thread.js knowing what a status line is.

Two rules the seam depends on. **redpen mints the request id**, because clayjs
emits the first frame from inside `send()` and a mapping built from the return
value is built too late to route it. And **the turn is written to the store before
`transport.send` is called**, for the same reason.

### One request at a time

`wire serve` runs a process per request and allows eight, so two in flight means
two programs reading, editing and writing one file, and the second write silently
loses the first one's change. A send while something is running is stored as a
`queued` turn and drains when the wire frees up.

A queued turn drains automatically **while the page is live, but not after a
reload**: nobody then knows whether the earlier request's edit landed, and sending
automatically could ask for the same change twice. On load it becomes `parked`, a
state of its own rather than `queued` plus a flag, and renders with a send button
that `thread.resume` is behind. Everything you typed is still there; only the
sending waits for you.

**Known limitation: the rule is per page, not per file.** Two tabs open on the
same document each hold their own one-request lock, so both can have an agent
running against one file at the same time, and the second write silently loses the
first one's change. A page cannot see the other tab's request, and a guard here
would only ever be a guess. The durable answer is serialisation in `wire serve`,
where the file actually is, and that is where it will go.

### Sending is asymmetric, on purpose

The **first** message sends on leaving the popover, which is today's behaviour and
the flow the whole tool is built around: tap, type, tap the next thing. Once a
thread exists the comment text is frozen and becomes the thread's opening line;
**follow-ups are explicit**, on `send ›` or ⌘↵, so pressing Escape to stop reading
a reply cannot send anything.

### Reading a reply

A reply that arrives while the popover is shut reaches you through three surfaces
of increasing durability: the dock strip while the request runs, a ring on the marker, and the stored
`unread` flag that survives a reload. Opening the thread is what clears it.

### Resolve

`Resolve` in the popover's `⋯` menu retires a comment: it leaves the page entirely,
the list panel grows an `N resolved` button, and that list offers `reopen` and `discard`.
Resolved means *you are done with this*, not that the agent succeeded — a resolved
comment still exports, carrying `resolved` and its thread, and `review()`'s summary
counts it.

Resolving does **not** cancel a running request. Cancel is refused once a request
reaches `landing`, so "resolve cancels" is a promise redpen cannot keep, and the
agent is mid-edit of your file either way. The turn keeps running, and a reply
arriving afterwards brings the comment back onto the page.

### The reply line

One line on stdout that parses as a JSON object carrying a `redpen` key:

```bash
echo "rewriting the intro"
REPLY=$(node rewrite.js "$HTMLCLAY_WIRE_FILE")
printf '{"redpen":1,"reply":%s}\n' "$(jq -Rs . <<<"$REPLY")"
```

| field | meaning |
|---|---|
| `redpen` | the marker, value `1`. Required, and conventionally first |
| `reply` | the text. A blank line starts a paragraph |
| `append` | optional `true`: concatenate onto the reply so far instead of replacing it |

Every other line is progress. The sentinel is what stops a handler that pipes `jq`
or an HTTP response to stdout from having its tool output adopted as the agent's
words. `redpen` goes first because a line cut at the wire's 4 KB limit keeps its
head, and that head is the only thing the mangled-reply rule can match on.

Full contract, including the byte budget and the print-before-exit rule:
`htmlclay/docs/wire.md`.

### The follow-up payload

`said` is **always the newest message**, so a handler written before threads
existed reads `payload.said` and gets the current instruction. On turn one the
payload is byte-identical to what redpen sent before threads: `turn` and `thread`
appear only from the second exchange onwards.

```json
{
  "kind": "comment",
  "page": "index.htmlclay",
  "said": "two sentences, not three",
  "turn": 2,
  "thread": [
    { "you": "make this shorter", "agent": "Cut the second clause." },
    { "you": "two sentences, not three" }
  ],
  "item": { "…": "the projection, with thread stripped out" },
  "region": { "key": "s1", "selector": "#s1", "tag": "section" }
}
```

`{you, agent}` pairs, because the pairing is the information and it reads
correctly pasted into a prompt with no legend. A failed exchange carries `failed`
instead of `agent`. An exchange that finished and said nothing carries
`done: true`: that is every handler written before replies existed, and calling
it a failure invites the next agent to redo or undo work that actually landed. Bounds, on the payload only: the last 8 exchanges with an
`earlier` count, each string at 2000 characters except the newest `you`, which is
never cut. Progress lines never travel; they are the agent's own output coming
back at it.

## Host integration

What a host page needs and cannot infer from the API.

### What `mount()` returns

The adapter, not the engine. The engine is on `.pen`:

```js
const review = RedpenReview.mount({ clickThrough: 'canvas.beat-video' });

review.pen         // the RedpenEngine, for everything in the section above
review.refresh()   // rescan the DOM for questions (closes the box first)
review.open(key)   // open one question
review.next() / review.prev()   // step through unanswered questions
review.point(on)   // comment mode on or off
review.mode(v)     // set 'note' | 'draw' | null, or read the current mode
review.copy(which) // copy 'all' (default), 'comments' or 'drawing' to the clipboard
review.json()      // the same payload, as an object
review.send()      // send every held comment, returns how many started
review.thread      // the conversation on a comment; see The thread
review.onComment(fn)  // called with each finished comment; returns its own unsubscribe
review.destroy()
```

**`mount` and `destroy` are a safe cycle**, which is what a review-mode toggle needs.
`destroy` flushes the answer being typed before it tears anything down, drops its
listeners, strips the `data-tooltip` attributes it added, removes the click-through
rule, and destroys the engine. Answers live in IndexedDB, so a later `mount` picks up
exactly where the last one left off. Call `refresh()` rather than remounting when only
the questions changed.

On `dist/redpen.js` both aliases return the page's one adapter, which the bundle mounts
on load; pass options through `window.REDPEN_KEY` or call `Redpen.create` for a second
engine.

### Mount options

| option | default | what it does |
|---|---|---|
| `key` | `location.pathname` (`review:` + pathname through `RedpenReview.mount` in the review bundle) | storage namespace, so one page keeps one set of comments |
| `mount` | `document.body` | the element the engine paints its overlay into |
| `attr` | `data-review-ask` | the attribute the page authors its questions on |
| `tools` | `['comment', 'draw']` | which mode toggles the dock builds |
| `keys` | `true` | bind the keyboard shortcuts |
| `clickThrough` | none | a selector for artwork that stays clickable under the capture overlay |
| `wire` | auto | the transport; see below |
| `onComment` | none | a first listener, the same thing `onComment(fn)` adds |

### The transport

`wire` is `auto`: when `dist/redpen-wire.js` is on the page and clayjs exposes
`clay.wire`, the dock connects itself and grows a **Send** button. A page with no wire
logs one warning and keeps `Copy JSON`, which is the ordinary case. Pass a transport
object of your own (anything with `send`, and optionally `attach`, `detach` and
`cancel`) to connect that one instead, or `wire: false` to connect nothing and attach
later yourself.

### Moving the dock

The adapter's stylesheet is **prepended**, not appended, so a host stylesheet of equal
specificity wins without `!important`. The dock root carries `.rpDock` and `.rprBar`,
and only the single-class `.rprBar` rule sets `bottom`:

```css
.rprBar { bottom: 52px; }   /* clear of the page's own bottom-right control */
```

Class names worth knowing: `.rpDock` / `.rprBar` (the dock), `.rprPop` (the box on the
element), `.rpCount` / `.rprCount` (the `2/6` counter), and `[data-pointing]` on the
dock root while comment mode is on.

### Theme

Every piece of redpen chrome (`.rpDock`, `.rprPop`, `.rprTip`, `.rpToast`)
defines its own `--rp-*` tokens and reads none of the host's, so a host variable named
`--paper` cannot bleed into it. The dock picks light or dark from the page's own
background luminance, falls back to `prefers-color-scheme`, and writes
`data-rp-theme="light|dark"` on each of those roots. It re-picks on `load`, on a
`prefers-color-scheme` change, and whenever `class`, `style` or `data-theme` changes on
`<html>` or `<body>`, so a host theme toggle needs no call. To recolour it, redefine
the tokens; a host rule of equal specificity wins by source order:

```css
.rpDock, .rprPop, .rprTip, .rpToast { --rp-flag: #B4292F; }
```

Markers and ink never follow the theme. They are marks on the page, not chrome.

### Sitting above the overlay

Comment mode covers the viewport with a capture overlay, so a host control that must
stay clickable while it is on (the toggle that turns review off, typically) needs to
outrank it. The layers:

| z-index | layer |
|---|---|
| 99990 | `.laInkLayer` finished strokes |
| 99991 | `.laMarkers` note markers, `.laReqs` request chips |
| 99992 | `.laOverlay` capture overlay (comment mode) |
| 99995 | `.rpDock` the dock |
| 99996 | `.rprPop` the box on the element |
| 99997 | `.rprTip` hover tips, `.rpToast` undo toast (the shortcut card is a panel view inside the dock) |

### Excluding your own chrome

`[data-la-ui]` is not only redpen's marker for its own injected UI: `identify.js` skips
any `[data-la-ui]` subtree, so a host puts it on its own controls to keep them from
being annotated.

```html
<button id="review-toggle" data-la-ui="1">review marks</button>
```

Without it, a click beside your button files a note about your button.

## Source layout

```
store.js         v3 blob: notes + strokes per target, one shared id counter, legacy migration
targets.js       the target registry and the two coordinate bases (getScreenCTM / fractions)
identify.js      cssPath / describe / resolve / nthOfType
note-surface.js  capture overlay + numbered markers + rubber-band drag + region/area capture
draw-surface.js  ink canvas + lazy brush + smoothing + RDP + SVG path export
ink-layer.js     finished strokes as SVG marks in one overlay <svg> per viewbox target
engine.js        Redpen.create → RedpenEngine extends EventTarget
thread.js        the conversation: turns, one request in flight, replies, resolve, sweep
popover.js       the box on the element: question, comment, thread, leaving is sending
dock.js          the dock: stylesheet, bar, panels, hover peek, undo toast, theme, keys
mount.js         composes engine + thread + popover + dock into one adapter
wire.js          transport: request → clay.wire payload, wire frames → thread calls
standalone.js    one page-wide adapter, plus the NotesTool / DrawTool / FeedbackHub globals
index.js         engine + dock          → dist/redpen.js
index-core.js    engine alone           → dist/redpen-core.js
index-review.js  engine + dock, mount() → dist/redpen-review.js
index-wire.js    the transport          → dist/redpen-wire.js
notes.js / draw.js / feedback-hub.js
                 import-and-go entry points kept for the scene pages that symlink them
```

## Storage

One blob per instance key, `redpen:<key>`:

```json
{ "v": 3, "counter": 42,
  "answers": { "ask-also": { "said": "keep it struck", "q": "Keep 'also' struck?", "at": "2026-08-04T…" } },
  "targets": {
    "p19": { "basis": { "type": "viewbox", "viewBox": [0, 0, 1000, 820] },
             "notes":   [ { "id": 16, "text": "…", "kind": "region", "box": { "x": 388, "y": 600, "w": 250, "h": 60 } } ],
             "strokes": [ { "id": 17, "points": [[392, 612]], "width": 3 } ] } } }
```

Notes and strokes share one counter, so an agent can be told "fix stroke 4 on p12".

A note carries the conversation too: `thread` (one entry per exchange), `resolved`
(an ISO string, absent when open), `unread`, and `draft` (an unsent follow-up).
**The version stays 3.** That is not tidiness: `adoptBlob` refuses any other
version outright, the store then comes up empty *and writable*, and the first write
commits an empty blob over a full one — so a bump is the most reliable way to
destroy every stored note for anyone still running an older vendored bundle. Extra
fields round-trip verbatim in both directions already, which is what makes the
thread need no bump. `data()`'s note whitelist exports `thread` and `resolved`, and
deliberately not `unread` or `draft`: one is local read-state and the other is
unsent scratch.

```json
{ "id": 16, "text": "make this shorter", "kind": "element",
  "thread": [ { "id": "t1", "request": "rp-9c4a-16-t1", "ask": "make this shorter",
                "at": "2026-08-23T18:04:11.021Z", "state": "done",
                "reply": "Cut the second clause.", "repliedAt": "…", "endedAt": "…",
                "progress": ["reading the file"] } ] }
```

`state` is `queued | parked | sent | acked | landing | done | error | cancelled |
unknown`. The middle six are the wire's; `queued`, `parked` and `unknown` are
redpen's: parked is a queued turn a reload found and is waiting for you to send,
and unknown means the page was closed while the request was still running. `ask` is frozen at
send time and never rewritten, so a reworded comment cannot silently claim the
agent was answering something it never saw. Caps, so a chatty handler cannot grow a
blob that is rewritten on every keystroke: a progress line stores at 400
characters, a turn keeps its last 50 with a `progressDropped` count, and an
assembled reply caps at 32 KB.

Legacy `la-notes:<path>` / `la-draw:<path>` fold into the `page` target on first
load; the old keys are left in place. Old draw pixels keep a `px` flag until the
first layout with a real box to normalize against, so nothing is silently discarded.

## Build

`dist/redpen.js`, `dist/redpen-core.js`, `dist/redpen-review.js` and
`dist/redpen-wire.js` are checked-in IIFE bundles. After editing `src/`:

```bash
npm run build
```

## Test

`test/two-target.html` is a dependency-free fixture: two `viewBox="0 0 1000 820"`
SVGs side by side, each registered as a viewbox target, loaded with
`dist/redpen-core.js`. Open it from `file://` and use the buttons to exercise
show-filtering, overshoot binding, resize, persistence and `data()`.

## Consumers

- `hyperclay/new-home/index.html` — the review adapter, and the reason it exists.
  Vendors `dist/redpen-review.js` into `assets/vendor/`, mounts and destroys it on a
  `body.review` class toggle, and uses every hook in [Host integration](#host-integration):
  the bar moved to clear its own toggle, that toggle at z-index 99993 and marked
  `data-la-ui`, and `clickThrough: 'canvas.beat-video'` for the baked animations.
- `ARCHIVE_PROJECTS/experiments/homepage-illustrations/` — `notes.js`, `draw.js`, `feedback-hub.js`
  there are symlinks into this repo's `src/`; scene pages import them as modules
  (notes via the `lineart.js` import, draw via its own script tag).
- `the-freelance-rate-calculator/index.html` — loads `dist/redpen.js` through a
  guarded loader that only runs on `file:` or localhost.

## JSON shape

`Copy JSON` copies the review projection, `pen.review()`, on every page. One flat
`items` list, because an answer and a volunteered comment are the same thing to
whoever reads them, a place on the page plus something the reviewer said about it.
Ink rides along in `strokes`:

```json
{
  "page": "index.html",
  "answered": 2, "unanswered": 4, "orphaned": 0, "resolved": 1,
  "coords": "note boxes are fractions of the target element box … stroke paths are integer px in the stated viewBox; …",
  "viewBox": [0, 0, 1280, 577],
  "strokes": [
    { "id": 7, "d": "M 392 612 L 470 640", "bbox": [392, 612, 78, 28], "closed": false, "width": 3 }
  ],
  "items": [
    { "kind": "answer", "ask": "ask-also", "question": "Keep 'also' struck?", "said": "keep it struck",
      "anchor": { "selector": "span.flag#ask-also", "tag": "span", "text": "also" } },
    { "kind": "comment", "id": 3, "shape": "element", "said": "wrong verb",
      "anchor": { "selector": "section.hero > h2", "tag": "h2", "text": "Your break-even rate" } }
  ]
}
```

`viewBox` is the pixel box the stroke paths are in, and `coords` states the rule the
note boxes are in. A registered target's items and strokes carry `target_id`, and a
`targets` block states that target's own basis, coordinate rule and viewBox; see
[Coordinate bases](#coordinate-bases). `Copy comments only` drops `strokes` and that
`viewBox`; `Copy drawing only` keeps only them.

### `pen.data()`

The other shape, unchanged, because it has live consumers: grouped by target, each
target stating its own coordinate rule, and notes projected through a fixed field
whitelist.

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
