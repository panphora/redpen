// review.js — the review adapter: the chrome for answering an agent's questions
// about a page and volunteering comments of your own, over the headless engine.
// Builds to dist/redpen-review.js beside the other two bundles.
//
//   <script src="redpen-review.js"></script>
//   <script>const review = RedpenReview.mount({});</script>
//
// The page authors its questions in HTML, one attribute on the element being
// asked about, and the element's id is the answer's key:
//
//   <span class="flag" id="ask-also" data-review-ask="Keep 'also' struck?">…</span>
//
// The id is required rather than derived. A key derived from the question text
// changes the moment the question is reworded, which silently orphans the answer
// instead of marking it stale — the one outcome this whole design exists to
// prevent.
//
// Two modes, and they cannot both be live: redpen's capture overlay is
// position:fixed inset:0, so while you are pointing, nothing on the page takes a
// click. Reading is the default and pointing is the exception.

import { create } from './engine.js';
import { mark, chrome } from './mark.js';
import { tailRect } from './note-surface.js';

const CSS = `
  .rprBar { position: fixed; right: 14px; bottom: 14px; z-index: 99995; display: flex; align-items: center; gap: 6px;
    font-family: var(--mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 11.5px; letter-spacing: .06em;
    background: var(--card, #FDFDFC); border: 1px solid var(--line, #DCD8D2); border-radius: 7px; padding: 4px 6px; }
  .rprBar button { font: inherit; letter-spacing: inherit; color: var(--ink-faint, #8A857E); background: none;
    border: 0; border-radius: 5px; padding: 3px 7px; cursor: pointer; }
  .rprBar button:hover { color: var(--ink, #17110C); background: var(--line, #DCD8D2); }
  .rprBar button.on { color: var(--paper, #FDFDFC); background: var(--flag, #e5484d); }
  .rprBar .rprCount { color: var(--ink, #17110C); padding: 0 2px; font-variant-numeric: tabular-nums; }
  .rprBar .rprWarn { color: var(--flag, #e5484d); }
  .rprBar.failed { border-color: var(--flag, #e5484d); }
  .rprBar .rprStep { padding: 3px 5px; }

  .rprPop { position: fixed; z-index: 99996; box-sizing: border-box; width: 380px; max-width: calc(100vw - 32px);
    background: var(--card, #FDFDFC); border: 1px solid var(--line, #DCD8D2); border-radius: 9px; padding: 12px 13px;
    box-shadow: 0 8px 30px rgba(0, 0, 0, .13);
    font-family: var(--mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 12.5px; line-height: 1.5;
    color: var(--ink, #17110C); }
  .rprPop[hidden] { display: none; }
  /* the textarea and the bar's buttons set their own display, which outranks the
     UA rule for [hidden] and would leave a "hidden" field on screen */
  .rprPop [hidden], .rprBar [hidden] { display: none !important; }
  .rprPop .rprTop { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; }
  .rprPop .rprEyebrow { flex: 1; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-faint, #8A857E); }
  .rprPop .rprX { font: inherit; color: var(--ink-faint, #8A857E); background: none; border: 0; cursor: pointer; padding: 0 2px; }
  .rprPop .rprQ { margin: 0 0 9px; }
  .rprPop .rprWas { margin: 0 0 7px; padding: 6px 8px; border-left: 2px solid #E8A33D;
    color: var(--ink-faint, #8A857E); font-size: 11.5px; }
  .rprPop .rprWas b { display: block; font-weight: 400; letter-spacing: .1em; text-transform: uppercase; font-size: 9.5px; margin-bottom: 3px; }
  .rprPop .rprStill { display: block; margin-top: 5px; font: inherit; color: var(--ink, #17110C);
    background: none; border: 0; border-bottom: 1px solid #E8A33D; border-radius: 0; padding: 0; cursor: pointer; }
  .rprPop textarea { display: block; width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical;
    font: inherit; color: inherit; background: var(--paper, #fff); border: 1px solid var(--line, #DCD8D2);
    border-radius: 6px; padding: 7px 8px; }
  .rprPop textarea:focus { outline: 1px solid var(--ink-soft, #B7B3AE); }
  .rprPop .rprFoot { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .rprPop .rprFoot .rprSpacer { flex: 1; }
  .rprPop .rprFoot button { font: inherit; color: var(--ink-faint, #8A857E); background: none; border: 0;
    border-radius: 5px; padding: 3px 6px; cursor: pointer; }
  .rprPop .rprFoot button:hover { color: var(--ink, #17110C); background: var(--line, #DCD8D2); }
  .rprPop .rprHint { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-faint, #8A857E); }
  .rprPop .rprScroll { max-height: 55vh; overflow-y: auto; }
  .rprPop .rprOrphan { margin: 0 0 10px; }
  .rprPop .rprOrphan p { margin: 0 0 4px; }
  .rprPop .rprOrphan .q { color: var(--ink-faint, #8A857E); font-size: 11.5px; }
  .rprPop .rprOrphan + .rprOrphan { border-top: 1px solid var(--line, #DCD8D2); padding-top: 10px; }

  /* The thread. Your words are muted and the reply is full ink, because the
     reply is what you opened this to read. */
  .rprPop .rprThread { max-height: 46vh; overflow-y: auto; margin: 0 0 9px; }
  .rprPop .rprTurn + .rprTurn { border-top: 1px solid var(--line, #DCD8D2); margin-top: 10px; padding-top: 10px; }
  .rprPop .rprWho { display: flex; align-items: baseline; gap: 8px; margin: 0 0 3px;
    font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--ink-faint, #8A857E); }
  .rprPop .rprWhen { margin-left: auto; font-variant-numeric: tabular-nums; }
  .rprPop .rprSaid, .rprPop .rprReply, .rprPop .rprMangled { margin: 0 0 6px; white-space: pre-wrap; }
  .rprPop .rprSaid { color: var(--ink-faint, #8A857E); }
  .rprPop .rprReply { color: var(--ink, #17110C); }
  .rprPop .rprMangled { color: var(--flag, #e5484d); }
  .rprPop .rprTrail { margin: 0 0 6px; font-size: 11.5px; color: var(--ink-faint, #8A857E); }
  .rprPop .rprTrail summary { cursor: pointer; }
  .rprPop .rprTrail p { margin: 3px 0 0 12px; white-space: pre-wrap; }
  .rprPop .rprTurnState { display: flex; align-items: center; gap: 7px;
    font-size: 11.5px; color: var(--ink-faint, #8A857E); }
  .rprPop .rprNow { margin: 2px 0 0 14px; font-size: 11.5px; color: var(--ink-faint, #8A857E); }
  .rprPop .rprTurnState button { font: inherit; color: var(--ink-faint, #8A857E); background: none; border: 0;
    border-radius: 5px; padding: 2px 6px; margin-left: auto; cursor: pointer; }
  .rprPop .rprTurnState button:hover { color: var(--ink, #17110C); background: var(--line, #DCD8D2); }

  /* The pill. One dot class, shared with the thread's state line, so a colour
     never means one thing in the corner and another in the popover. */
  .rprDot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; flex: none;
    background: var(--ink-faint, #8A857E); }
  .rprDot.working { background: var(--flag, #e5484d); animation: rprWirePulse 1.1s ease-in-out infinite; }
  .rprDot.done { background: #2f9e44; }
  .rprDot.error { background: var(--flag, #e5484d); }
  @keyframes rprWirePulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }

  .rprWire { position: fixed; left: 14px; bottom: 14px; z-index: 99995; display: flex; align-items: center; gap: 8px;
    max-width: min(420px, calc(100vw - 28px)); cursor: pointer;
    font-family: var(--mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 11.5px; letter-spacing: .06em;
    background: var(--card, #FDFDFC); border: 1px solid var(--line, #DCD8D2); border-radius: 7px; padding: 5px 8px; }
  .rprWire[hidden] { display: none; }
  .rprWire .rprWireText { color: var(--ink, #17110C); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rprWire button { font: inherit; letter-spacing: inherit; color: var(--ink-faint, #8A857E); background: none;
    border: 0; border-radius: 5px; padding: 2px 6px; cursor: pointer; }
  .rprWire button:hover { color: var(--ink, #17110C); background: var(--line, #DCD8D2); }

  .rprTip { position: fixed; z-index: 99997; max-width: 320px; pointer-events: none;
    font-family: var(--mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 11.5px; line-height: 1.45;
    color: var(--ink, #17110C); background: var(--card, #FDFDFC); border: 1px solid var(--line, #DCD8D2);
    border-radius: 7px; padding: 6px 8px; box-shadow: 0 6px 20px rgba(0, 0, 0, .12); }

  /* Pointing is read off redpen's own bar, never off a class on the authored
     <body>: body's attributes changing makes the whole body a dirty root, so one
     click on point would protect the entire page from the agent's own edit. */
  body:has(.rprBar[data-pointing]) main { outline: 1px solid var(--flag, #e5484d); outline-offset: 6px; }
`;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// Prepended, not appended: these are defaults a host is expected to override
// (where the bar sits, mostly), and mount() runs after the page's own <style>
// has been parsed. Appending would win every same-specificity tie and force the
// host into specificity games with its own review chrome.
function injectStyles() {
  if (document.getElementById('rprStyle')) return;
  const style = mark(el('style'));
  style.id = 'rprStyle';
  style.textContent = CSS;
  document.head.prepend(style);
}

// `html { scroll-behavior: smooth }` means the element is still moving when
// scrollIntoView returns, and a popover positioned then lands where the element
// used to be. Wait for three still frames, with a cap for a page that never settles.
function afterScroll(node, fn) {
  const r = node.getBoundingClientRect();
  const onScreen = r.top >= 0 && r.bottom <= innerHeight;
  if (!onScreen) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  let last = null, still = 0, frames = 0;
  const step = () => {
    const y = node.getBoundingClientRect().top;
    if (last !== null && Math.abs(y - last) < 0.5) still++; else still = 0;
    last = y;
    if (still >= 3 || frames++ > 120) return fn();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function mount(opts = {}) {
  const attr = opts.attr || 'data-review-ask';
  const key = opts.key ?? ('review:' + location.pathname);
  // a selector for artwork the page covers with pointer-events:none; see pointing
  const clickThrough = opts.clickThrough || '';
  let clickThroughRule = null;
  injectStyles();

  const pen = create({ key, mount: document.body });

  // ---------- declaring the questions ----------

  function scan() {
    const list = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('[' + attr + ']')) {
      const ask = node.getAttribute(attr);
      if (!node.id) {
        console.warn('[review] skipped a question with no id — the id is the answer\'s key', node);
        continue;
      }
      // two questions on one id share one answer and count twice
      if (seen.has(node.id)) {
        console.warn('[review] skipped a duplicate question id: ' + node.id, node);
        continue;
      }
      seen.add(node.id);
      list.push({ key: node.id, ask, el: node });
    }
    pen.setRequests(list);
    return list.length;
  }

  // ---------- the bar ----------

  const bar = chrome(el('div', 'rprBar'));
  const prevBtn = el('button', 'rprStep', '‹');
  const count = el('span', 'rprCount', '0/0');
  const nextBtn = el('button', 'rprStep', '›');
  const orphanBtn = el('button', 'rprWarn', '');
  const resolvedBtn = el('button', null, '');
  const pointBtn = el('button', null, 'point');
  const copyBtn = el('button', null, 'copy');
  bar.append(prevBtn, count, nextBtn, orphanBtn, resolvedBtn, pointBtn, copyBtn);
  document.body.appendChild(bar);

  // ---------- the question's hover preview ----------

  // The ask used to be copied onto the page's own question elements as
  // data-tooltip, so whatever tooltip library the page already loads would show
  // it. That writes an attribute onto an AUTHORED node: it reaches the saved
  // file, and it makes every question element a dirty root that scoped live-sync
  // then protects from the agent's own edit, which is the one thing this whole
  // chain exists to let through. redpen renders the preview itself now, reading
  // the ask straight off the page's attribute and writing nothing back.
  //
  // A page that put its own data-tooltip on a question still wins, which is what
  // the old copy did too: two bubbles for one element is worse than either.
  const tip = chrome(el('div', 'rprTip'));
  tip.hidden = true;
  document.body.appendChild(tip);

  // Guarded, because `hidden = true` writes the attribute whether or not it
  // changed, and this runs on every pointer transition across the page. On a
  // host that reads redpen's marking those records are dropped at intake; on one
  // that does not, moving the mouse would trigger an autosave.
  function hideTip() {
    if (!tip.hidden) tip.hidden = true;
  }

  function showTip(node) {
    const text = node.dataset.tooltip ? '' : node.getAttribute(attr);
    if (!text) return hideTip();
    tip.textContent = text;
    tip.hidden = false;
    // Measured after it is filled and visible, or the flip below reads a height
    // of zero and never flips.
    const r = node.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const above = r.top - t.height - 8;
    tip.style.left = Math.max(8, Math.min(r.left, innerWidth - t.width - 8)) + 'px';
    tip.style.top = (above < 8 ? r.bottom + 8 : above) + 'px';
  }

  // One handler for both showing and hiding: pointing at anything that is not a
  // question is the ordinary way a preview ends. While the capture overlay is up
  // every event targets the overlay, so pointing mode hides it for free.
  const onHover = e => {
    const node = e.target && e.target.closest ? e.target.closest('[' + attr + ']') : null;
    node ? showTip(node) : hideTip();
  };

  document.addEventListener('mouseover', onHover);
  document.addEventListener('focusin', onHover);
  // The bubble is position:fixed and placed once, so a scroll leaves it pointing
  // at where the question used to be.
  window.addEventListener('scroll', hideTip, true);

  function refresh() {
    const list = pen.requests();
    const done = list.filter(r => r.answered).length;
    count.textContent = done + '/' + list.length;
    const orphaned = pen.orphans();
    orphanBtn.hidden = !orphaned.length;
    orphanBtn.textContent = orphaned.length + ' orphaned';
    // A resolved comment is off the page entirely, so this button is the only
    // way back to it. Hidden at zero, like the orphan list it mirrors.
    const retired = pen.items().filter(n => n.resolved).length;
    resolvedBtn.hidden = !retired;
    resolvedBtn.textContent = retired + ' resolved';
    pointBtn.classList.toggle('on', pen.mode() === 'note');
  }

  // ---------- the popover ----------

  const pop = chrome(el('div', 'rprPop'));
  pop.hidden = true;
  const eyebrow = el('span', 'rprEyebrow');
  const resolveBtn = el('button', 'rprX', 'resolve');
  const closeBtn = el('button', 'rprX', '×');
  const top = el('div', 'rprTop');
  top.append(eyebrow, resolveBtn, closeBtn);
  const was = el('div', 'rprWas');
  const wasLabel = el('b', null, 'answered when the question read');
  const wasText = el('span');
  // Without this the export can never say "they read the new wording and stood by
  // it": staying silent and never opening it look identical to whoever reads the
  // paste. Re-affirming restamps the stored question, which clears `stale`.
  const stillBtn = el('button', 'rprStill', 'still stands');
  was.append(wasLabel, wasText, stillBtn);
  const question = el('p', 'rprQ');
  const field = el('textarea');
  field.placeholder = 'your answer';
  const orphanList = el('div', 'rprScroll');
  const threadBox = el('div', 'rprThread');
  const foot = el('div', 'rprFoot');
  const leftBtn = el('button', null, '‹ prev');
  const spacer = el('span', 'rprSpacer');
  const hint = el('span', 'rprHint', '⌘↵ next');
  const rightBtn = el('button', null, 'next ›');
  foot.append(leftBtn, spacer, hint, rightBtn);
  // The thread scrolls; the composer and the footer sit outside it, so the send
  // button never scrolls away and the popover's height stays bounded — which is
  // what keeps place()'s above/below flip working.
  pop.append(top, was, question, orphanList, threadBox, field, foot);
  document.body.appendChild(pop);

  let open = null;   // {kind:'ask', key} | {kind:'comment', id} | {kind:'orphans'}

  function place(anchor) {
    const r = tailRect(anchor);
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(r.left, innerWidth - w - 16);
    left = Math.max(16, left);
    let top2 = r.bottom + 8;
    if (top2 + h > innerHeight - 16) top2 = Math.max(16, r.top - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top2 + 'px';
  }

  // A popover with nowhere to point still has to be reachable: with no anchor it
  // parks above the bar rather than being revealed at whatever its static
  // position happens to be, which is usually off-screen.
  function atBar() {
    const r = bar.getBoundingClientRect();
    pop.style.left = Math.max(16, r.right - pop.offsetWidth) + 'px';
    pop.style.top = Math.max(16, r.top - pop.offsetHeight - 8) + 'px';
  }

  function show(anchor) {
    pop.hidden = false;
    if (anchor) afterScroll(anchor, () => place(anchor));
    else atBar();
  }

  // The engine has no "the reviewer finished writing" event, and none of the
  // three it does have is one: `item:add` fires while the note is still empty,
  // `change` fires on every keystroke, and the done button usually emits nothing
  // at all, because it routes through flushAnswer, which returns early when the
  // text has not changed since the last one.
  //
  // So the signal hangs off LEAVING a comment, not off any particular button,
  // and every way out goes through here: done, close, Escape, turning point mode
  // on, opening a question or the orphan list, tapping a second comment while
  // the first is open, and destroy. Only discard is different, and it clears
  // `open` itself before removing the item, which is what makes it silent.
  function leaveOpen() {
    const at = open && open.kind === 'comment' ? open : null;
    flushAnswer();
    open = null;
    if (at && shouldAnnounce(at)) announce(at.id);
  }

  function close() {
    leaveOpen();
    pop.hidden = true;
    pen.openRequest(null);
  }

  // A Set, not one slot. mount() can be given a listener and a transport bundle
  // can add its own later, and two attachments must not silently replace each
  // other's callback, nor may one detach remove a listener it never installed.
  const commentListeners = new Set();
  if (typeof opts.onComment === 'function') commentListeners.add(opts.onComment);

  // A comment is announced when it is finished for the first time, and never
  // again. Every way out of the popover runs leaveOpen, and comments became
  // reopenable the moment marker tags took clicks, so without this guard opening
  // a thread to read the agent's reply and pressing Escape would send the same
  // comment again and cost a second edit to the file. Once a thread exists the
  // first message is already gone and the comment text is frozen, which is what
  // makes the thread check sufficient on its own.
  function shouldAnnounce(at) {
    const note = pen.items().find(n => n.id === at.id);
    if (!note) return false;
    if (note.thread && note.thread.length) return false;
    return note.text !== at.textAtOpen;
  }

  function announce(id) {
    if (!commentListeners.size && !transport) return;
    // The whole projection, not just the item: an area note on a registered
    // target reads as fractions of the wrong box without the basis and coords
    // that live at the top of this envelope, and building a second per-item
    // projection here is how those two rules drift apart.
    const review = pen.review();
    const item = review.items.find(i => i.kind === 'comment' && i.id === id);
    // Whitespace is not a comment. The stored note keeps whatever was typed;
    // this is only about what counts as something to send.
    if (!item || !item.said || !item.said.trim()) return;
    for (const fn of [...commentListeners]) {
      try {
        fn(item, review);
      } catch (err) {
        console.warn('[review] onComment failed', err);
      }
    }
    // Turn one. A host listener and a transport are not alternatives: a page can
    // want its own copy of every comment AND an agent working on them, and the
    // announce guard has already established this note has no thread yet.
    sendTurn(id, item.said);
  }

  // ---------- the thread ----------
  //
  // A comment can hold a conversation. You say something, an agent answers in
  // words and edits the file, and you answer that. The words live on the note as
  // `note.thread`, one entry per exchange. The edit does not live here at all: it
  // reaches the page as an ordinary external change to the file, through live
  // sync, so a finished request and a visible change are two different events.
  //
  // This owns every piece of that state and knows nothing about clay.wire. A
  // transport is handed in, speaks in request ids, and calls back through `sink`.
  // Turning a wire frame into one of those four calls is the transport's whole
  // job, because picking a reply out of a stream of status lines takes knowledge
  // of the wire that has no business in here.

  const CAP = { line: 400, lines: 50, reply: 32 * 1024, say: 2000, pairs: 8, history: 16 * 1024 };
  // has a request on the wire, versus is simply not finished. `queued` is the
  // difference, and every rule below cares which one it is looking at.
  const RUNNING = new Set(['sent', 'acked', 'landing']);
  const UNFINISHED = new Set(['queued', 'parked', 'sent', 'acked', 'landing']);

  // redpen mints the request id rather than taking one back from the transport,
  // because clayjs emits the first frame synchronously from inside send(): a
  // mapping built from the return value is built too late to route it. Two tabs
  // open on one file would mint turn t1 of note 16 at the same moment and a
  // reused id is refused outright on the wire, so the token makes that collision
  // impossible rather than unlikely.
  const token = Math.random().toString(36).slice(2, 6);

  let transport = null;
  let inflight = null;             // the one request id on the wire, or null
  let detachWhenIdle = false;      // a disconnect waiting out the request in flight
  const byRequest = new Map();     // request id -> { noteId, turnId }

  const now = () => new Date().toISOString();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function noteById(id) {
    return pen.items().find(n => n.id === id) || null;
  }

  // Mutating a turn is always a read-modify-write through the engine: items()
  // hands out shallow copies, so a turn reached any other way is either a copy
  // nothing will store or a shared sub-object that changes without a save.
  function withTurn(requestId, fn) {
    const at = byRequest.get(requestId);
    if (!at) return false;
    let touched = false;
    pen.updateNote(at.noteId, note => {
      const turn = (note.thread || []).find(t => t.id === at.turnId);
      if (!turn) return;
      touched = true;
      fn(turn, note);
    });
    if (touched) showTurn(at.noteId, at.turnId);
    return touched;
  }

  // A turn that reached a terminal state lets the queue move. The drain is
  // deliberately only reachable from here, which is what keeps the reload case
  // honest: the load sweep terminates turns without going through the sink, so a
  // queued turn found at load stays queued and waits to be sent by hand.
  function settleTurn(requestId, state, error) {
    const ok = withTurn(requestId, turn => {
      turn.state = state;
      turn.endedAt = now();
      if (error) turn.error = cut(String(error), CAP.line);
    });
    byRequest.delete(requestId);
    if (inflight === requestId) inflight = null;
    // A teardown that waited for this request finishes here rather than draining
    // into it. Checked first: draining would start the next program on a review
    // that has already asked to be disconnected.
    if (detachWhenIdle && !inflight) { disconnect(); return ok; }
    // Drained even when no turn was found. A comment discarded mid-request
    // leaves a request nothing can be written to, and holding the queue behind
    // it would wedge every later send for the life of the page.
    drain();
    return ok;
  }

  // What review.js hands the transport. Every method takes the request id, and
  // one that names no live turn is dropped: a frame for a comment discarded
  // mid-request is not an error, it is a race with a button.
  const sink = {
    state(requestId, state, error) {
      if (!RUNNING.has(state)) return settleTurn(requestId, state, error);
      return withTurn(requestId, turn => { turn.state = state; });
    },
    progress(requestId, line) {
      const said = cut(String(line ?? '').trim(), CAP.line);
      if (!said) return false;
      return withTurn(requestId, turn => {
        const trail = turn.progress || (turn.progress = []);
        trail.push(said);
        // A chatty handler must not grow a blob that is rewritten on every
        // keystroke. The count is kept because "it said 200 things" is itself
        // worth knowing when you are reading back what happened.
        if (trail.length > CAP.lines) {
          turn.progressDropped = (turn.progressDropped || 0) + (trail.length - CAP.lines);
          trail.splice(0, trail.length - CAP.lines);
        }
      });
    },
    reply(requestId, text, opts = {}) {
      const said = String(text ?? '');
      if (!said) return false;
      let rang = false, back = false;
      const ok = withTurn(requestId, (turn, note) => {
        turn.reply = cut(opts.append && turn.reply ? turn.reply + said : said, CAP.reply);
        turn.repliedAt = now();
        // Three surfaces of increasing durability carry a reply that arrived
        // while you were elsewhere: the pill for a moment, this ring on the
        // marker, and the stored flag that survives a reload. Reading the thread
        // is what clears it, so an open popover was already read.
        // Typing a follow-up already brings a resolved comment back; so does
        // being answered. You retired it before you knew there were words
        // coming, and words you cannot reach are words you did not get.
        if (note.resolved) { delete note.resolved; back = true; }
        if (open && open.kind === 'comment' && open.id === note.id) return;
        rang = !note.unread;
        note.unread = true;
      });
      // Only when the ring actually appeared. Markers are re-measured and
      // rebuilt from scratch on every layout, so repainting for a reply to a
      // marker that is already ringing is work for no visible change.
      // `back` as well as `rang`: a comment returning from the resolved list
      // has no marker at all yet, so the layout that draws it is not optional.
      if (rang || back) pen.layout();
      return ok;
    },
    // The transport's own remark about an exchange, which is how a mangled reply
    // line becomes visible without review.js knowing what a status line is.
    note(requestId, line) {
      const said = cut(String(line ?? '').trim(), CAP.line);
      if (!said) return false;
      return withTurn(requestId, turn => { turn.note = said; });
    },
  };

  // The exchanges as the agent should read them: `{you, agent}` pairs, because
  // the pairing IS the information and it reads correctly pasted into a prompt
  // with no legend. Progress lines never travel — they are the agent's own
  // output coming back at it.
  function historyFor(thread) {
    if (!thread || thread.length < 2) return null;
    const pairs = thread.map((t, i) => {
      const last = i === thread.length - 1;
      const you = last ? t.ask : cut(t.ask, CAP.say);
      if (t.reply) return { you, agent: cut(t.reply, CAP.say) };
      if (UNFINISHED.has(t.state)) return { you };
      // Finished, edited the file, said nothing. That is every handler written
      // before replies existed, and calling it a failure invites the next agent
      // to redo or undo work that actually landed.
      if (t.state === 'done') return { you, done: true };
      return { you, failed: t.error || 'this one did not finish' };
    });
    let earlier = 0;
    while (pairs.length > CAP.pairs || (pairs.length > 1 && JSON.stringify(pairs).length > CAP.history)) {
      pairs.shift();
      earlier++;
    }
    return { pairs, earlier };
  }

  // One request in flight across the whole page. `wire serve` runs a process per
  // request and allows eight, so two at once means two programs reading, editing
  // and writing one file, and the second write silently loses the first one's
  // change. Tap, comment, tap the next thing is redpen's ordinary rhythm, which
  // makes that a likely path rather than an exotic one.
  function sendTurn(noteId, said) {
    if (!transport || detachWhenIdle) return null;
    // The store starts empty and fills a few milliseconds later. A turn written
    // in that window is erased by the read that follows it.
    if (!pen.loaded()) return null;
    const text = String(said ?? '');
    if (!text.trim()) return null;
    const note = noteById(noteId);
    if (!note) return null;

    const turnId = 't' + ((note.thread ? note.thread.length : 0) + 1);
    const queued = !!inflight;
    const turn = {
      id: turnId,
      request: `rp-${token}-${noteId}-${turnId}`,
      // Frozen at send time and never rewritten, so a reworded comment cannot
      // silently claim the agent was answering something it never saw. A stored
      // answer's question follows the same rule for the same reason.
      ask: text,
      at: now(),
      state: queued ? 'queued' : 'sent',
    };

    // Written before the transport is called, never after: clayjs emits the
    // first frame from inside send(), and a frame arriving then has to find a
    // turn to attach to. Typing a follow-up is also the strongest evidence there
    // is that you are not done with this comment, so a resolved one comes back.
    let stored = null;
    pen.updateNote(noteId, n => {
      stored = n.thread || (n.thread = []);
      stored.push(turn);
      delete n.draft;
      delete n.resolved;
    });
    if (!stored) return null;
    if (queued) showTurn(noteId, turnId);
    else dispatch(noteId, turnId);
    return turn;
  }

  // Everything both send paths share. Reads the turn back out of the store
  // rather than taking it as an argument, so the payload always describes what
  // was actually written.
  function dispatch(noteId, turnId) {
    const note = noteById(noteId);
    const thread = (note && note.thread) || [];
    const at = thread.findIndex(t => t.id === turnId);
    if (at < 0) return;
    const requestId = thread[at].request;

    byRequest.set(requestId, { noteId, turnId });
    inflight = requestId;
    pen.updateNote(noteId, n => {
      for (const t of n.thread || []) if (t.id === turnId) { t.state = 'sent'; delete t.stalled; }
    });
    showTurn(noteId, turnId);

    const projection = pen.review();
    const history = historyFor(thread.slice(0, at + 1));
    let ok = null;
    try {
      ok = transport.send({
        id: requestId,
        ask: thread[at].ask,
        turn: at + 1,
        item: projection.items.find(i => i.kind === 'comment' && i.id === noteId) || null,
        projection,
        ...(history ? { history } : {}),
      });
    } catch (err) {
      // Unguarded, a throw here left `inflight` pinned to a request that could
      // never settle, and every later comment queued behind it for the life of
      // the page, with nothing shown anywhere.
      console.warn('[review] the transport threw', err);
    }
    // A transport that refuses says so on the thread. It is an outcome, not an
    // exception: there is nowhere better for it to go, and the exchange is
    // sitting right there waiting to be read.
    if (!ok) settleTurn(requestId, 'error', 'this could not be sent');
  }

  // The oldest queued turn on the page, sent now that the wire is free. Live
  // only: you pressed send and nothing changed under you, so sending for you is
  // what you asked for. After a reload nobody knows whether the earlier
  // request's edit landed, and sending then could ask for the same change twice.
  function drain() {
    if (!transport || inflight || detachWhenIdle) return;
    let pick = null;
    for (const note of pen.items()) {
      for (const turn of note.thread || []) {
        if (turn.state !== 'queued') continue;
        if (!pick || turn.at < pick.at) pick = { noteId: note.id, turnId: turn.id, at: turn.at };
      }
    }
    if (pick) dispatch(pick.noteId, pick.turnId);
  }

  // A page closed mid-request takes clayjs's records with it, so nothing will
  // ever settle those turns. On load — never at mount, where the store is still
  // empty — they become `unknown`, which is terminal, so a follow-up is allowed
  // again. Any reply that had already arrived is kept: an agent that said what
  // it did and then lost the page still told you something true.
  function sweepUnfinished() {
    pen.updateNotes(note => {
      if (!note.thread) return false;
      let changed = false;
      for (const turn of note.thread) {
        // A turn that was only ever queued still has everything you typed and
        // was never sent, so it is parked rather than terminated: the thread
        // gives it a send button and waits for you to press it. `stalled` is the
        // flag this state replaced, deleted here so a turn stored by an older
        // build arrives in the new shape.
        if (turn.state === 'queued') { turn.state = 'parked'; delete turn.stalled; changed = true; continue; }
        if (turn.state === 'parked') { if (turn.stalled) { delete turn.stalled; changed = true; } continue; }
        if (!RUNNING.has(turn.state)) continue;
        turn.state = 'unknown';
        turn.endedAt = now();
        changed = true;
      }
      return changed;
    });
  }

  // Held rather than only handed back, because destroy() has to take the
  // transport down too: a subscription outliving the review it feeds writes into
  // an engine that is already gone.
  //
  // A running request is still writing the file, and clearing the wire's one-at-
  // a-time lock here is what let a reattached page start a second program
  // alongside it, with the second write silently losing the first. The teardown
  // waits for the terminal frame instead. Nothing new goes out meanwhile:
  // `transport` stays set, so `connect` refuses a second one and `sendTurn`
  // refuses outright rather than queueing work that would drain into a detach.
  //
  // `force` is destroy's: the engine is going away, so a subscription that
  // outlived it would write into nothing. That is the one path that still drops
  // the lock, and the durable answer to it is serialisation in htmlclay, where
  // the file is, not another guard in a page that can be closed.
  function disconnect(force = false) {
    if (!transport) return;
    if (inflight && !force) { detachWhenIdle = true; return; }
    const t = transport;
    transport = null;
    inflight = null;
    detachWhenIdle = false;
    byRequest.clear();
    dropPill();
    t.detach?.();
  }

  const thread = {
    // Returns its own disconnect, and refuses a second transport rather than
    // replacing the first: two would each believe they own `inflight`, and the
    // one-request rule is the only thing keeping two agents off one file.
    connect(t) {
      if (!t || typeof t.send !== 'function') return () => {};
      if (transport) {
        console.warn('[review] a transport is already connected');
        return () => {};
      }
      transport = t;
      buildPill();
      t.attach?.(sink);
      return () => { if (transport === t) disconnect(); };
    },
    // The one queued turn a reload left behind. Live queueing drains itself;
    // this is the hand on the button that the reload rule deliberately removed.
    resume(noteId, turnId) {
      if (!transport || inflight) return false;
      const note = noteById(noteId);
      const turn = (note && note.thread || []).find(t => t.id === turnId);
      if (!turn || turn.state !== 'parked') return false;
      dispatch(noteId, turnId);
      return true;
    },
    // Done with this comment, which is not the same as the agent succeeding. A
    // running request is left running: cancel is refused once a request reaches
    // landing, so "resolve cancels" is a promise redpen cannot keep, and the
    // agent is mid-edit of your file either way.
    resolve(noteId, on = true) {
      const ok = pen.updateNote(noteId, n => {
        if (on) n.resolved = now();
        else delete n.resolved;
      });
      if (ok) pen.layout();
      return ok;
    },
    send: sendTurn,
    open(noteId) {
      const note = noteById(noteId);
      if (note) openComment(note);
    },
    // A deep copy, because items() shares a note's nested objects by reference:
    // a host that edited what it was given would change what the store writes
    // without ever saving, which looks like it works until it does not.
    of(noteId) {
      const note = noteById(noteId);
      if (!note || !note.thread) return [];
      return Object.freeze(JSON.parse(JSON.stringify(note.thread)).map(Object.freeze));
    },
    connected: () => !!transport,
    busy: () => !!inflight,
  };

  // ---------- the thread's chrome ----------

  const CANCELLABLE = new Set(['sent', 'acked']);

  const TURN_LABEL = {
    queued: 'waiting for the wire',
    // Its own state rather than `queued` plus a flag. Two things that had to be
    // read together is what let drain() pick up a turn the reload had parked and
    // send it with nobody's hand on the button.
    parked: 'waiting for you to send it',
    sent: 'sending to the agent',
    acked: 'the agent is working',
    landing: 'waiting for the change',
    error: 'the agent failed',
    // `wire serve` signals rather than kills, and lets a handler that is
    // mid-write finish, so the file may still change after this.
    cancelled: 'the agent was asked to stop',
    unknown: 'this was still running when the page was closed',
  };

  function turnLine(turn) {
    if (turn.state === 'error') return turn.error || TURN_LABEL.error;
    // Only review.js can say this: the wire knows the request has not landed and
    // the thread knows the words already arrived.
    if (turn.state === 'landing' && turn.reply) return 'answered, waiting for the change';
    // A handler that edited the file and said nothing is the ordinary shape of a
    // formatter or a shell script, so this is a statement, not an accusation. A
    // reply that arrived MANGLED reads completely differently, at full size,
    // where the reply would have been.
    if (turn.state === 'done') return turn.reply ? '' : 'finished with nothing said, the change is on the page';
    return TURN_LABEL[turn.state] || turn.state;
  }

  function dotClass(state) {
    if (RUNNING.has(state)) return 'working';
    if (state === 'done') return 'done';
    if (state === 'error') return 'error';
    return '';
  }

  const clock = iso => {
    const t = iso ? new Date(iso) : null;
    return t && !isNaN(t) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  };

  const firstLine = text => (String(text || '').split('\n')[0].trim().slice(0, 72) || 'an empty comment');

  function whoRow(name, iso) {
    const row = el('div', 'rprWho');
    row.append(el('span', null, name), el('span', 'rprWhen', clock(iso)));
    return row;
  }

  // A blank line starts a new paragraph and a single newline survives inside one,
  // which is how a handler's prose was written and how it should read back.
  //
  // textContent on every path, never innerHTML. The handler is a local process,
  // but local stops meaning safe the moment that process is a model summarizing a
  // document it just read.
  function paragraphs(into, text, cls) {
    for (const block of String(text).split(/\n{2,}/)) {
      const said = block.trim();
      if (said) into.appendChild(el('p', cls, said));
    }
  }

  // Reuses the <details> it is handed rather than building a fresh one, because
  // this is the only element in a turn a person can have opened, and a
  // replacement always arrives closed. Emptying it leaves `open` alone.
  function trailFor(turn, box) {
    const n = turn.progress.length + (turn.progressDropped || 0);
    const trail = box || el('details', 'rprTrail');
    trail.textContent = '';
    trail.appendChild(el('summary', null, `${n} progress line${n === 1 ? '' : 's'}`));
    if (turn.progressDropped) trail.appendChild(el('p', null, `…${turn.progressDropped} earlier`));
    for (const line of turn.progress) trail.appendChild(el('p', null, line));
    return trail;
  }

  function stateRow(turn) {
    const label = turnLine(turn);
    const cancellable = CANCELLABLE.has(turn.state) && transportCan('cancel');
    // A queued turn drains itself while the page is live. One found after a
    // reload does not, because nobody knows whether the request it was waiting
    // behind ever landed, so it asks rather than repeating a change.
    const parked = turn.state === 'parked';
    if (!label && !cancellable && !parked) return null;
    const row = el('div', 'rprTurnState');
    row.append(el('span', ('rprDot ' + dotClass(turn.state)).trim()), el('span', null, label));
    if (cancellable) {
      const btn = el('button', null, 'cancel');
      btn.addEventListener('click', () => transport.cancel(turn.request));
      row.append(btn);
    } else if (parked) {
      const btn = el('button', null, 'send');
      btn.addEventListener('click', () => { thread.resume(openNoteId(), turn.id); renderThread(); });
      row.append(btn);
    }
    return row;
  }

  const openNoteId = () => (open && open.kind === 'comment' ? open.id : null);
  const transportCan = name => !!(transport && typeof transport[name] === 'function');

  // A status line lands every few hundred milliseconds, and rebuilding the whole
  // conversation for each one closed every open progress trail and dragged the
  // scroll back to the bottom while you were reading turn one. Only the turn
  // that actually changed is redrawn; the rest is left standing.
  let threadFor = null;
  const turnBlocks = new Map();   // turnId -> the block standing in the box
  const turnTrails = new Map();   // turnId -> its progress <details>
  const turnDrawn = new Map();    // turnId -> what it looked like when last drawn

  // Everything about a turn that can change after it is written. `ask` is frozen
  // at send time, which is why it is deliberately not in here.
  const turnSig = turn => [
    turn.state, turn.repliedAt || '', turn.reply || '', turn.note || '',
    (turn.progress || []).length, turn.progressDropped || 0,
  ].join('\u0000');

  function forgetThread() {
    threadBox.textContent = '';
    turnBlocks.clear();
    turnTrails.clear();
    turnDrawn.clear();
  }

  function fillTurn(block, turn, them) {
    const trail = turn.progress && turn.progress.length
      ? trailFor(turn, turnTrails.get(turn.id))
      : null;
    if (trail) turnTrails.set(turn.id, trail);
    block.textContent = '';
    block.append(whoRow('you', turn.at));
    paragraphs(block, turn.ask, 'rprSaid');
    if (turn.reply) {
      block.append(whoRow(them, turn.repliedAt));
      paragraphs(block, turn.reply, 'rprReply');
    }
    if (turn.note) block.appendChild(el('p', 'rprMangled', turn.note));
    if (trail) block.appendChild(trail);
    const state = stateRow(turn);
    if (state) block.appendChild(state);
    // What it is doing right now, spelled out under the state line. The trail
    // above holds the rest and stays collapsed.
    if (RUNNING.has(turn.state) && turn.progress && turn.progress.length) {
      block.appendChild(el('p', 'rprNow', turn.progress[turn.progress.length - 1]));
    }
  }

  function renderThread() {
    const id = openNoteId();
    if (id !== threadFor) { forgetThread(); threadFor = id; }
    if (id == null) return (threadBox.hidden = true);
    const turns = thread.of(id);
    threadBox.hidden = !turns.length;
    if (!turns.length) return void forgetThread();

    // Sticky only when you are already at the end. Having scrolled up to read is
    // a statement that you do not want to be dragged back down.
    const stick = threadBox.scrollHeight - threadBox.scrollTop - threadBox.clientHeight < 24;
    const them = (transport && transport.label) || 'agent';
    const live = new Set();
    let grew = false;

    for (const turn of turns) {
      live.add(turn.id);
      let block = turnBlocks.get(turn.id);
      if (!block) {
        block = el('div', 'rprTurn');
        turnBlocks.set(turn.id, block);
        grew = true;
      }
      const drawn = turnSig(turn) + '\u0000' + them;
      if (turnDrawn.get(turn.id) !== drawn) {
        fillTurn(block, turn, them);
        turnDrawn.set(turn.id, drawn);
      }
      // Turns only ever arrive at the end, so appending the ones that are not in
      // the box yet keeps the order without moving anything already placed.
      if (block.parentNode !== threadBox) threadBox.appendChild(block);
    }

    for (const [turnId, block] of turnBlocks) {
      if (live.has(turnId)) continue;
      block.remove();
      turnBlocks.delete(turnId);
      turnTrails.delete(turnId);
      turnDrawn.delete(turnId);
    }

    if (stick || grew) scrollThreadToEnd();
  }

  // A hidden element measures zero, so this does nothing until the popover is on
  // screen — which is exactly why openComment calls it again after show().
  function scrollThreadToEnd() {
    threadBox.scrollTop = threadBox.scrollHeight;
  }

  // ---------- the pill ----------
  // Built inside connect(), so a page with no transport never pays for it.

  let pill = null, pillDot = null, pillText = null, pillCancel = null;
  let pillAt = null, pillTimer = null;

  const pillTurn = () => (pillAt ? thread.of(pillAt.noteId).find(t => t.id === pillAt.turnId) || null : null);

  function buildPill() {
    if (pill) return;
    pill = chrome(el('div', 'rprWire'));
    pill.hidden = true;
    pillDot = el('span', 'rprDot');
    pillText = el('span', 'rprWireText');
    pillCancel = el('button', null, 'cancel');
    pill.append(pillDot, pillText, pillCancel);
    // The pill is a way back to the conversation it is reporting on, which is
    // the only place the reply it is hinting at can actually be read.
    pill.addEventListener('click', e => {
      if (e.target === pillCancel || !pillAt) return;
      thread.open(pillAt.noteId);
    });
    pillCancel.addEventListener('click', () => {
      const turn = pillTurn();
      if (turn && CANCELLABLE.has(turn.state) && transportCan('cancel')) transport.cancel(turn.request);
    });
    document.body.appendChild(pill);
  }

  function dropPill() {
    clearTimeout(pillTimer);
    pill?.remove();
    pill = pillDot = pillText = pillCancel = null;
    pillAt = null;
  }

  // Hidden rather than removed: the next request reuses the element. dropPill
  // takes it down for good, which is what a disconnect wants and a discarded
  // comment does not.
  function hidePill() {
    clearTimeout(pillTimer);
    if (pill) pill.hidden = true;
    pillAt = null;
  }

  function renderPill(noteId, turnId) {
    if (!pill) return;
    const turn = thread.of(noteId).find(t => t.id === turnId);
    if (!turn) return;
    // The newest request owns the pill. An older one still finishing would
    // otherwise overwrite the state of the one just sent.
    const showing = pillTurn();
    const mine = pillAt && pillAt.noteId === noteId && pillAt.turnId === turnId;
    if (showing && !mine && RUNNING.has(showing.state)) return;
    pillAt = { noteId, turnId };
    clearTimeout(pillTimer);
    pill.hidden = false;
    pillDot.className = ('rprDot ' + dotClass(turn.state)).trim();
    // The agent's own words while it is working, the state otherwise. This is
    // what the pill has always shown, and the thread's state row deliberately
    // does the opposite: there the label leads and the live line sits under it.
    const live = CANCELLABLE.has(turn.state) && turn.progress && turn.progress.length;
    pillText.textContent = (live ? turn.progress[turn.progress.length - 1] : turnLine(turn)) || 'done';
    pillCancel.hidden = !(CANCELLABLE.has(turn.state) && transportCan('cancel'));
    // A finished request stops being news. An error stays until the next one, so
    // a failure cannot scroll past unread.
    if (turn.state === 'done' || turn.state === 'cancelled') {
      pillTimer = setTimeout(hidePill, 2500);
    }
  }

  // One repaint for every way a turn changes, so no caller has to remember which
  // of the two surfaces its change is visible on.
  function showTurn(noteId, turnId) {
    renderPill(noteId, turnId);
    if (openNoteId() === noteId) renderThread();
  }

  // ---------- answering ----------

  let opened = null;   // the field's value when it was opened

  // Writing only on a real edit is not an optimization. An answer stores the
  // question it was replying to, so an unconditional write on close would restamp
  // a STALE answer with the new wording just because it was looked at, quietly
  // erasing the fact that it answered a different question.
  function flushAnswer(force) {
    if (!open) return;
    if (!force && field.value === opened) return;
    opened = field.value;
    if (open.kind === 'ask') pen.answer(open.key, field.value);
    // Once the first message is sent the comment text is fixed: it is the
    // thread's opening line and the agent has already been given it. The field
    // becomes the composer from then on, and what you type is an unsent draft.
    else if (open.kind === 'comment' && open.threaded) {
      pen.updateNote(open.id, n => { if (field.value) n.draft = field.value; else delete n.draft; });
    } else if (open.kind === 'comment') pen.setNote(open.id, field.value);
  }

  // Every keystroke, with no debounce. The store already collapses this: one blob
  // write is in flight at a time and anything typed during it is folded into a
  // single follow-up write, so typing fast costs one extra write, not one per
  // character. A delay would only buy back the window in which work is lost.
  field.addEventListener('input', () => flushAnswer());

  function openAsk(k) {
    leaveOpen();
    const list = pen.requests();
    const r = list.find(x => x.key === k);
    if (!r) return;
    open = { kind: 'ask', key: k };
    pen.openRequest(k);
    eyebrow.textContent = `ask ${r.n} of ${list.length}`;
    resolveBtn.hidden = true;
    threadBox.hidden = true;
    threadBox.textContent = '';
    field.placeholder = 'your answer';
    question.hidden = false;
    question.textContent = r.ask;
    was.hidden = !r.stale;
    wasText.textContent = r.askedWas || '';
    orphanList.hidden = true;
    orphanList.textContent = '';
    field.hidden = false;
    field.value = opened = r.answer || '';
    leftBtn.hidden = false;
    leftBtn.textContent = '‹ prev';
    rightBtn.textContent = 'next ›';
    // Reset, not just unhidden: a threaded comment leaves it saying `send`, and
    // in here ⌘↵ steps to the next question.
    hint.textContent = '⌘↵ next';
    hint.hidden = false;
    show(document.getElementById(k));
    field.focus();
  }

  function openComment(item) {
    leaveOpen();
    // leaveOpen may have been the call that created this comment's thread, and
    // `item` is a copy taken before it ran. Reading the stale copy is what made
    // re-clicking an open comment's own marker reopen it in pre-thread mode,
    // with the text its first turn had already frozen editable again.
    item = noteById(item.id) || item;
    // Reading the thread is what clears the marker's ring, and opening the
    // popover is the only way to read it.
    if (item.unread) {
      pen.updateNote(item.id, n => { delete n.unread; });
      pen.layout();
    }
    // textAtOpen is what the announce guard compares against. `opened` cannot do
    // that job: the input listener moves it on every keystroke, so by the time
    // the popover closes it always equals the current text.
    const threaded = !!(item.thread && item.thread.length);
    open = { kind: 'comment', id: item.id, textAtOpen: item.text || '', threaded };
    pen.openRequest(null);
    const t = item.target || {};
    eyebrow.textContent = `comment ${item.id} · ${t.tag || item.kind}${t.classes && t.classes.length ? '.' + t.classes[0] : ''}`;
    question.hidden = true;
    was.hidden = true;
    orphanList.hidden = true;
    orphanList.textContent = '';
    resolveBtn.hidden = false;
    resolveBtn.textContent = item.resolved ? 'reopen' : 'resolve';
    renderThread();
    field.hidden = false;
    field.placeholder = threaded ? 'reply to the agent…' : 'your comment';
    field.value = opened = (threaded ? item.draft : item.text) || '';
    leftBtn.hidden = false;
    leftBtn.textContent = 'discard';
    // Sending is asymmetric on purpose. The first message still goes on leaving
    // the popover, which is the flow this whole tool is built around: tap, type,
    // tap the next thing. A follow-up is explicit, because by then you are in a
    // conversation and pressing Escape must not send.
    rightBtn.textContent = threaded ? 'send ›' : 'done ›';
    hint.hidden = !threaded;
    hint.textContent = '⌘↵ send';
    const anchor = t.selector ? document.querySelector(t.selector) : null;
    show(anchor);
    // renderThread ran while the popover was still hidden, because place() has to
    // measure a filled one. Nothing inside a hidden element has a scroll height,
    // so the newest exchange is only reachable once it is on screen.
    scrollThreadToEnd();
    field.focus();
  }

  // The orphan list is the whole reason answers store their question. These are
  // David's words against a question the page no longer asks, and the only way
  // one leaves is him clicking discard.
  function openOrphans() {
    leaveOpen();
    open = { kind: 'orphans' };
    pen.openRequest(null);
    const list = pen.orphans();
    eyebrow.textContent = `${list.length} orphaned`;
    resolveBtn.hidden = true;
    threadBox.hidden = true;
    threadBox.textContent = '';
    question.hidden = false;
    question.textContent = 'answers to questions the page no longer asks. They still export.';
    was.hidden = true;
    field.hidden = true;
    hint.hidden = true;
    leftBtn.hidden = true;
    rightBtn.textContent = 'close';
    orphanList.hidden = false;
    orphanList.textContent = '';
    for (const o of list) {
      const row = el('div', 'rprOrphan');
      row.append(el('p', 'q', o.askedWas || o.key), el('p', null, o.answer));
      const drop = el('button', null, 'discard');
      drop.addEventListener('click', () => {
        pen.answer(o.key, '');
        openOrphans();
        if (!pen.orphans().length) close();
      });
      row.append(drop);
      orphanList.appendChild(row);
    }
    pop.hidden = false;
    atBar();
  }

  // Mirrors the orphan list exactly, and for the same reason: these are David's
  // own words, and the only way one ever leaves is him clicking discard.
  function openResolved() {
    leaveOpen();
    open = { kind: 'resolved' };
    pen.openRequest(null);
    const list = pen.items().filter(n => n.resolved);
    eyebrow.textContent = `${list.length} resolved`;
    resolveBtn.hidden = true;
    question.hidden = false;
    question.textContent = 'comments you are done with. They still export.';
    was.hidden = true;
    threadBox.hidden = true;
    threadBox.textContent = '';
    field.hidden = true;
    hint.hidden = true;
    leftBtn.hidden = true;
    rightBtn.textContent = 'close';
    orphanList.hidden = false;
    orphanList.textContent = '';
    for (const n of list) {
      const row = el('div', 'rprOrphan');
      row.append(el('p', null, firstLine(n.text)));
      const back = el('button', null, 'reopen');
      back.addEventListener('click', () => {
        thread.resolve(n.id, false);
        thread.open(n.id);
      });
      const drop = el('button', null, 'discard');
      drop.addEventListener('click', () => {
        pen.remove(n.id);
        if (pen.items().some(x => x.resolved)) openResolved();
        else close();
      });
      row.append(back, drop);
      orphanList.appendChild(row);
    }
    pop.hidden = false;
    atBar();
  }

  function sendFollowUp() {
    if (!open || open.kind !== 'comment' || !open.threaded) return;
    const said = field.value;
    if (!said.trim()) return;
    // Cleared before the send, so the keystroke flush that follows cannot write
    // the draft back over a message that is already on the wire.
    field.value = opened = '';
    if (!thread.send(open.id, said)) field.value = opened = said;
    renderThread();
  }

  function step(dir) {
    flushAnswer();
    const list = pen.requests();
    if (!list.length) return;
    const at = open && open.kind === 'ask' ? list.findIndex(r => r.key === open.key) : -1;
    const from = at < 0 ? (dir > 0 ? -1 : 0) : at;
    // forward stops at what still needs an answer; back walks everything, because
    // re-reading what you already said is most of proofreading
    for (let i = 1; i <= list.length; i++) {
      const r = list[((from + dir * i) % list.length + list.length) % list.length];
      if (dir < 0 || !r.answered) return openAsk(r.key);
    }
    close();
    flash(copyBtn, 'all answered');
  }

  // ---------- pointing ----------
  // Artwork is often covered by an element carrying pointer-events:none, so
  // elementsFromPoint never returns it and a drag across the picture files an
  // AREA note about the surrounding divs instead of a REGION note in fractions
  // of the picture. The two look identical until the paste, which is what makes
  // it worth handling. `clickThrough` names those elements.
  //
  // A stylesheet rule, not a loop over the nodes: the host may mount artwork
  // lazily (this page mounts its beats on an IntersectionObserver), so a snapshot
  // taken when pointing starts misses everything that scrolls in afterwards. The
  // rule also needs no save-and-restore, and `!important` is what beats the
  // inline style the artwork writes on itself.
  if (clickThrough) {
    clickThroughRule = mark(el('style'));
    const rule = clickThroughRule;
    rule.id = 'rprClickThrough';
    rule.textContent = `body:has(.rprBar[data-pointing]) ${clickThrough} { pointer-events: auto !important; }`;
    document.head.appendChild(rule);
  }

  // The rule can stop working silently: on this page the inline style is written
  // by a generated file, and the day it moves into a class of its own the
  // specificity changes underneath us.
  // Held, not looked up. `document.getElementById('rprClickThrough')` in destroy
  // deletes whatever holds that id, including a node the PAGE authored, and a
  // deletion is a local change scoped live-sync will splice into the next disk
  // frame — so redpen would erase the agent's version of that node.
  function assertClickThrough() {
    if (!clickThrough) return;
    for (const node of document.querySelectorAll(clickThrough)) {
      const r = node.getBoundingClientRect();
      if (!r.width || r.top > innerHeight || r.bottom < 0) continue;
      const x = r.left + r.width / 2, y = Math.max(1, Math.min(innerHeight - 1, r.top + r.height / 2));
      if (!document.elementsFromPoint(x, y).includes(node)) {
        console.warn('[review] ' + clickThrough + ' is still not hit-testable: a drag on it will file an area note, not a region of the picture', node);
      }
      return;
    }
  }

  function pointing(on) {
    if (on) close();
    bar.toggleAttribute('data-pointing', on);
    pen.setMode(on ? 'note' : null);
    if (on) assertClickThrough();
    refresh();
  }

  // ---------- copy ----------

  // the resting label is captured once, not per call: two flashes inside the
  // window would otherwise restore each other's temporary text and stick
  const flashTimers = new WeakMap();

  function flash(btn, text) {
    if (!btn.dataset.rprLabel) btn.dataset.rprLabel = btn.textContent;
    clearTimeout(flashTimers.get(btn));
    btn.textContent = text;
    flashTimers.set(btn, setTimeout(() => { btn.textContent = btn.dataset.rprLabel; }, 1500));
  }

  function copy() {
    flushAnswer();
    const out = pen.review();
    const text = JSON.stringify(out, null, 2);
    const done = () => flash(copyBtn, `copied ✓ ${out.answered} answers · ${out.items.filter(i => i.kind === 'comment').length} comments`);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, () => fallback(text, done));
    } else {
      fallback(text, done);
    }
    return text;
  }

  function fallback(text, done) {
    const ta = chrome(el('textarea'));
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    ok ? done() : flash(copyBtn, 'copy failed');
  }

  // ---------- wiring ----------

  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  orphanBtn.addEventListener('click', () => (open && open.kind === 'orphans' ? close() : openOrphans()));
  resolvedBtn.addEventListener('click', () => (open && open.kind === 'resolved' ? close() : openResolved()));
  pointBtn.addEventListener('click', () => pointing(pen.mode() !== 'note'));
  copyBtn.addEventListener('click', copy);
  closeBtn.addEventListener('click', close);

  // Resolving closes: the comment has left the page, so leaving the popover open
  // on it would be showing you something that is no longer there. `open` is
  // cleared first for the same reason discard clears it — resolving is not a way
  // of finishing a comment, and must not send one.
  resolveBtn.addEventListener('click', () => {
    if (!open || open.kind !== 'comment') return;
    const id = open.id;
    const note = pen.items().find(n => n.id === id);
    if (!note) return;
    if (note.resolved) {
      thread.resolve(id, false);
      resolveBtn.textContent = 'resolve';
      return;
    }
    flushAnswer();
    open = null;
    thread.resolve(id, true);
    pop.hidden = true;
    pen.openRequest(null);
  });

  stillBtn.addEventListener('click', () => {
    if (!open || open.kind !== 'ask' || !field.value.trim()) return;
    flushAnswer(true);
    openAsk(open.key);
  });

  leftBtn.addEventListener('click', () => {
    if (!open) return;
    if (open.kind === 'comment') {
      const id = open.id;
      // Resolve deliberately does not cancel: it means you are done reading.
      // Discard means this should not have happened, which is the one gesture
      // that earns the ask. It is still refused once the agent is landing, so
      // the edit can arrive anyway.
      const running = (noteById(id)?.thread || []).find(t => CANCELLABLE.has(t.state));
      if (running && transportCan('cancel')) transport.cancel(running.request);
      // cleared first, so nothing writes the discarded text back on the way out
      open = null;
      pen.remove(id);
      // The pill outlived its own comment otherwise: every later repaint for
      // that turn found no turn and returned, freezing it on `the agent is
      // working` with a cancel button that did nothing.
      if (pillAt && pillAt.noteId === id) hidePill();
      pop.hidden = true;
      return;
    }
    step(-1);
  });

  rightBtn.addEventListener('click', () => {
    if (!open) return;
    if (open.kind === 'ask') step(1);
    else if (open.kind === 'comment' && open.threaded) sendFollowUp();
    else close();
  });

  pen.addEventListener('request:click', e => openAsk(e.detail.request.key));
  pen.addEventListener('item:add', e => openComment(e.detail.item));
  pen.addEventListener('item:click', e => openComment(e.detail.item));
  pen.addEventListener('change', e => {
    refresh();
    // Chips render before the store has read, so a question can be opened while
    // its stored answer is still in flight, showing an empty field for a question
    // that was already answered. Re-seed on arrival, but never over typing.
    if (e.detail.action === 'load' && open && open.kind === 'ask' && field.value === opened) {
      const r = pen.requests().find(x => x.key === open.key);
      if (r) field.value = opened = r.answer || '';
    }
    if (e.detail.action === 'load') sweepUnfinished();
  });
  pen.addEventListener('save:error', () => bar.classList.add('failed'));
  if (pen.saveFailed()) bar.classList.add('failed');

  const onKey = e => {
    const typing = e.target.closest && e.target.closest('input, textarea, [contenteditable]');
    if (e.key === 'Escape') {
      if (pen.mode() === 'note') return pointing(false);
      if (open) return close();
    }
    if (typing) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && open) {
        if (open.kind === 'ask') { e.preventDefault(); step(1); }
        else if (open.kind === 'comment' && open.threaded) { e.preventDefault(); sendFollowUp(); }
      }
      return;
    }
    // bare letters only: ⌘P is print and ⌘N is a new window, and stealing either
    // leaves the page in point mode behind the dialog
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'n') step(1);
    if (e.key === 'p') pointing(pen.mode() !== 'note');
  };
  window.addEventListener('keydown', onKey);

  // Belt and braces now that every keystroke writes: this only has anything to do
  // when the field changed without firing `input`. It cannot make an in-flight
  // IndexedDB write commit, so it shortens the exposure rather than removing it.
  const onPageHide = () => flushAnswer();
  window.addEventListener('pagehide', onPageHide);

  const onLayout = () => {
    if (pop.hidden || !open) return;
    if (open.kind === 'ask') {
      const node = document.getElementById(open.key);
      if (node) place(node);
    }
  };
  pen.addEventListener('layout', onLayout);

  scan();
  refresh();

  // Chips are placed against measured text. A webfont loading with font-display:
  // swap reflows every line box after that measurement, and nothing else repaints
  // until the first scroll, so the chips sit at the old coordinates.
  let live = true;
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (live) pen.layout(); });
  }

  return {
    pen,
    // closed first: a rescan can reword or drop the open question, and a pending
    // save would then be stored against wording the reviewer never saw
    refresh: () => { close(); scan(); refresh(); },
    open: openAsk,
    next: () => step(1),
    prev: () => step(-1),
    point: pointing,
    copy,
    // Registered after the fact so a transport can be a separate bundle that
    // attaches to this object, rather than something mount() has to be told
    // about before it runs. Returns its own unsubscribe: a caller may only ever
    // remove the listener it added.
    onComment(fn) {
      if (typeof fn !== 'function') return () => {};
      commentListeners.add(fn);
      return () => commentListeners.delete(fn);
    },
    json: () => pen.review(),
    thread,
    destroy() {
      live = false;
      leaveOpen();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('mouseover', onHover);
      document.removeEventListener('focusin', onHover);
      window.removeEventListener('scroll', hideTip, true);
      clickThroughRule?.remove();
      clickThroughRule = null;
      disconnect(true);
      pen.destroy();
      bar.remove();
      pop.remove();
      tip.remove();
    },
  };
}
