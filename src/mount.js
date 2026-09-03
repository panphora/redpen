// mount.js — one adapter, composed. The headless engine, the thread model, the
// on-element box and the dock, wired together and handed back as one object.
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
// instead of marking it stale, the one outcome this whole design exists to
// prevent.

import { create } from './engine.js';
import { createThread } from './thread.js';
import { createPopover } from './popover.js';
import { createDock } from './dock.js';
import { attach } from './wire.js';

export function mount(opts = {}) {
  const key = opts.key ?? location.pathname;
  const attr = opts.attr || 'data-review-ask';
  const tools = new Set(opts.tools || ['comment', 'draw']);
  const mountNode = opts.mount ?? document.body;

  const pen = create({ key, mount: mountNode });

  // A Set, not one slot. mount() can be given a listener and a transport bundle
  // can add its own later, and two attachments must not silently replace each
  // other's callback, nor may one detach remove a listener it never installed.
  const listeners = new Set();
  if (typeof opts.onComment === 'function') listeners.add(opts.onComment);

  // Held back rather than sent as you finish them. Per page, because a page you
  // are thinking through and one you are working through are different sittings.
  const holdKey = 'redpen:hold:' + key;
  const prefs = {
    hold: () => { try { return localStorage.getItem(holdKey) === '1'; } catch { return false; } },
    setHold: v => { try { v ? localStorage.setItem(holdKey, '1') : localStorage.removeItem(holdKey); } catch {} },
  };

  let live = true;

  const thread = createThread({ pen, listeners, prefs, onTurn });

  const popover = createPopover({
    pen, thread, prefs,
    toast: (text, undo) => dock.toast(text, undo),
    onChange: () => dock.render(),
    anchor: () => dock.node,
    step,
  });

  const dock = createDock({
    pen, thread, popover, prefs, tools, attr, mountNode, step,
    clickThrough: opts.clickThrough || '',
    keys: opts.keys !== false,
  });

  thread.setOpener(id => {
    const note = pen.items().find(n => n.id === id);
    if (note) popover.openComment(note);
  });

  // One repaint for every way a turn changes, so no caller has to remember which
  // of the two surfaces its change is visible on.
  function onTurn(noteId, turnId) {
    if (!live) return;
    dock.render();
    popover.onTurn(noteId, turnId);
  }

  // ---------- declaring the questions ----------

  function scan() {
    const list = [];
    const seen = new Set();
    for (const node of document.querySelectorAll('[' + attr + ']')) {
      const ask = node.getAttribute(attr);
      if (!node.id) {
        console.warn('[redpen] skipped a question with no id: the id is the answer\'s key', node);
        continue;
      }
      // two questions on one id share one answer and count twice
      if (seen.has(node.id)) {
        console.warn('[redpen] skipped a duplicate question id: ' + node.id, node);
        continue;
      }
      seen.add(node.id);
      list.push({ key: node.id, ask, el: node });
    }
    pen.setRequests(list);
    return list.length;
  }

  // forward stops at what still needs an answer; back walks everything, because
  // re-reading what you already said is most of proofreading
  function step(dir) {
    popover.flush();
    const list = pen.requests();
    if (!list.length) return;
    const at = popover.openAt();
    const i = at && at.kind === 'ask' ? list.findIndex(r => r.key === at.key) : -1;
    const from = i < 0 ? (dir > 0 ? -1 : 0) : i;
    for (let n = 1; n <= list.length; n++) {
      const r = list[((from + dir * n) % list.length + list.length) % list.length];
      if (dir < 0 || !r.answered) return popover.openAsk(r.key);
    }
    popover.leave();
    dock.flashCount('all answered');
  }

  // closed first: a rescan can reword or drop the open question, and a pending
  // save would then be stored against wording the reviewer never saw
  function refresh() {
    popover.leave();
    scan();
    dock.render();
  }

  scan();
  dock.render();

  pen.addEventListener('change', e => {
    if (!live) return;
    dock.render();
    if (e.detail.action === 'load') {
      thread.sweepUnfinished();
      popover.reseed();
    }
  });
  pen.addEventListener('save:error', () => dock.render());
  pen.addEventListener('layout', popover.relayout);

  // Chips are placed against measured text. A webfont loading with font-display:
  // swap reflows every line box after that measurement, and nothing else repaints
  // until the first scroll, so the chips sit at the old coordinates.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (live) pen.layout(); });
  }

  const adapter = {
    pen,
    refresh,
    open: popover.openAsk,
    next: () => step(1),
    prev: () => step(-1),
    point: on => dock.setMode(on ? 'note' : null),
    mode(v) {
      if (v === undefined) return pen.mode();
      dock.setMode(v || null);
      return pen.mode();
    },
    copy: which => dock.copy(which),
    json: () => dock.exportObject('all'),
    send: () => thread.sendPending(),
    thread,
    // Registered after the fact so a transport can be a separate bundle that
    // attaches to this object, rather than something mount() has to be told
    // about before it runs. Returns its own unsubscribe: a caller may only ever
    // remove the listener it added.
    onComment(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      live = false;
      popover.leave();
      thread.disconnect(true);
      dock.destroy();
      popover.destroy();
      pen.destroy();
    },
  };

  // A transport object is connected as it is. `auto` waits for clayjs to settle
  // when it is loading, because attach() reads window.clay.wire once; a page
  // with no wire gets a warning and keeps copy-JSON, which is the ordinary case.
  function attachWire(wire) {
    if (wire && typeof wire.send === 'function') {
      thread.connect(wire);
      dock.render();
      return;
    }
    const go = () => { if (live) attach(adapter); };
    const ready = window.clay && window.clay.ready;
    if (ready && typeof ready.then === 'function') ready.then(go, go);
    else go();
  }

  if (opts.wire !== false) attachWire(opts.wire);

  return adapter;
}
