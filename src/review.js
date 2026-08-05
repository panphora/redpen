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

  body.rprPointing main { outline: 1px solid var(--flag, #e5484d); outline-offset: 6px; }
`;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// Chrome the engine must never mistake for page content: topElementAt and
// elementsInArea both skip [data-la-ui] subtrees, so without this a click beside
// the popover files a note about the popover.
function chrome(node) {
  node.dataset.laUi = '1';
  node.setAttribute('sap-ignore', '');
  return node;
}

// Prepended, not appended: these are defaults a host is expected to override
// (where the bar sits, mostly), and mount() runs after the page's own <style>
// has been parsed. Appending would win every same-specificity tie and force the
// host into specificity games with its own review chrome.
function injectStyles() {
  if (document.getElementById('rprStyle')) return;
  const style = el('style');
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
  injectStyles();

  const pen = create({ key, mount: document.body });

  // ---------- declaring the questions ----------

  const tooltipped = [];

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
      // one string in the file: the hover preview keeps working through whatever
      // tooltip library the page already loads
      if (!node.dataset.tooltip) {
        node.dataset.tooltip = ask;
        tooltipped.push(node);
      }
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
  const pointBtn = el('button', null, 'point');
  const copyBtn = el('button', null, 'copy');
  bar.append(prevBtn, count, nextBtn, orphanBtn, pointBtn, copyBtn);
  document.body.appendChild(bar);

  function refresh() {
    const list = pen.requests();
    const done = list.filter(r => r.answered).length;
    count.textContent = done + '/' + list.length;
    const orphaned = pen.orphans();
    orphanBtn.hidden = !orphaned.length;
    orphanBtn.textContent = orphaned.length + ' orphaned';
    pointBtn.classList.toggle('on', pen.mode() === 'note');
  }

  // ---------- the popover ----------

  const pop = chrome(el('div', 'rprPop'));
  pop.hidden = true;
  const eyebrow = el('span', 'rprEyebrow');
  const closeBtn = el('button', 'rprX', '×');
  const top = el('div', 'rprTop');
  top.append(eyebrow, closeBtn);
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
  const foot = el('div', 'rprFoot');
  const leftBtn = el('button', null, '‹ prev');
  const spacer = el('span', 'rprSpacer');
  const hint = el('span', 'rprHint', '⌘↵ next');
  const rightBtn = el('button', null, 'next ›');
  foot.append(leftBtn, spacer, hint, rightBtn);
  pop.append(top, was, question, orphanList, field, foot);
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

  function close() {
    flushAnswer();
    pop.hidden = true;
    open = null;
    pen.openRequest(null);
  }

  // ---------- answering ----------

  let saveTimer = null;
  let opened = null;   // the field's value when it was opened

  // Writing only on a real edit is not an optimization. An answer stores the
  // question it was replying to, so an unconditional write on close would restamp
  // a STALE answer with the new wording just because it was looked at, quietly
  // erasing the fact that it answered a different question.
  function flushAnswer(force) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!open) return;
    if (!force && field.value === opened) return;
    opened = field.value;
    if (open.kind === 'ask') pen.answer(open.key, field.value);
    else if (open.kind === 'comment') pen.setNote(open.id, field.value);
  }

  field.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushAnswer, 400);
  });

  function openAsk(k) {
    flushAnswer();
    const list = pen.requests();
    const r = list.find(x => x.key === k);
    if (!r) return;
    open = { kind: 'ask', key: k };
    pen.openRequest(k);
    eyebrow.textContent = `ask ${r.n} of ${list.length}`;
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
    hint.hidden = false;
    show(document.getElementById(k));
    field.focus();
  }

  function openComment(item) {
    flushAnswer();
    open = { kind: 'comment', id: item.id };
    pen.openRequest(null);
    const t = item.target || {};
    eyebrow.textContent = `comment ${item.id} · ${t.tag || item.kind}${t.classes && t.classes.length ? '.' + t.classes[0] : ''}`;
    question.hidden = true;
    was.hidden = true;
    orphanList.hidden = true;
    orphanList.textContent = '';
    field.hidden = false;
    field.value = opened = item.text || '';
    leftBtn.hidden = false;
    leftBtn.textContent = 'discard';
    rightBtn.textContent = 'done ›';
    hint.hidden = true;
    const anchor = t.selector ? document.querySelector(t.selector) : null;
    show(anchor);
    field.focus();
  }

  // The orphan list is the whole reason answers store their question. These are
  // David's words against a question the page no longer asks, and the only way
  // one leaves is him clicking discard.
  function openOrphans() {
    flushAnswer();
    open = { kind: 'orphans' };
    pen.openRequest(null);
    const list = pen.orphans();
    eyebrow.textContent = `${list.length} orphaned`;
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
    const rule = el('style');
    rule.id = 'rprClickThrough';
    rule.textContent = `body.rprPointing ${clickThrough} { pointer-events: auto !important; }`;
    document.head.appendChild(rule);
  }

  // The rule can stop working silently: on this page the inline style is written
  // by a generated file, and the day it moves into a class of its own the
  // specificity changes underneath us.
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
    document.body.classList.toggle('rprPointing', on);
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
  pointBtn.addEventListener('click', () => pointing(pen.mode() !== 'note'));
  copyBtn.addEventListener('click', copy);
  closeBtn.addEventListener('click', close);

  stillBtn.addEventListener('click', () => {
    if (!open || open.kind !== 'ask' || !field.value.trim()) return;
    flushAnswer(true);
    openAsk(open.key);
  });

  leftBtn.addEventListener('click', () => {
    if (!open) return;
    if (open.kind === 'comment') {
      const id = open.id;
      clearTimeout(saveTimer);
      saveTimer = null;
      open = null;
      pen.remove(id);
      pop.hidden = true;
      return;
    }
    step(-1);
  });

  rightBtn.addEventListener('click', () => {
    if (!open) return;
    if (open.kind === 'ask') step(1);
    else close();
  });

  pen.addEventListener('request:click', e => openAsk(e.detail.request.key));
  pen.addEventListener('item:add', e => openComment(e.detail.item));
  pen.addEventListener('change', e => {
    refresh();
    // Chips render before the store has read, so a question can be opened while
    // its stored answer is still in flight, showing an empty field for a question
    // that was already answered. Re-seed on arrival, but never over typing.
    if (e.detail.action === 'load' && open && open.kind === 'ask' && field.value === opened) {
      const r = pen.requests().find(x => x.key === open.key);
      if (r) field.value = opened = r.answer || '';
    }
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
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && open && open.kind === 'ask') {
        e.preventDefault();
        step(1);
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
    json: () => pen.review(),
    destroy() {
      live = false;
      flushAnswer();
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('rprPointing');
      // the tooltips were this adapter's doing, and tolltop answers to any
      // [data-tooltip] regardless of review mode, so leaving them behind means
      // hovering a flag still shows the question after review is switched off
      for (const node of tooltipped) node.removeAttribute('data-tooltip');
      tooltipped.length = 0;
      document.getElementById('rprClickThrough')?.remove();
      pen.destroy();
      bar.remove();
      pop.remove();
    },
  };
}
