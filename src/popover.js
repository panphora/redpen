// popover.js — the box that opens on the element being talked about. One node,
// two modes: answering a question the page asked, and writing (or reading) a
// comment of your own.
//
// Every way out of it goes through one function, because the engine has no "the
// reviewer finished writing" event and none of the three it does have is one:
// `item:add` fires while the note is still empty, `change` fires on every
// keystroke, and the done button usually emits nothing at all. So the signal
// hangs off LEAVING the box. Escape is the one exit that puts back what the
// visit changed and sends nothing.

import { chrome } from './mark.js';
import { tailRect } from './note-surface.js';
import { RUNNING } from './thread.js';
import { renderIcon, iconMore, iconClose } from '@panphora/bevel/icons';

export const CANCELLABLE = new Set(['sent', 'acked']);

export const TURN_LABEL = {
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

export function turnLine(turn) {
  if (turn.state === 'error') return turn.error || TURN_LABEL.error;
  // Only redpen can say this: the wire knows the request has not landed and the
  // thread knows the words already arrived.
  if (turn.state === 'landing' && turn.reply) return 'answered, waiting for the change';
  // A handler that edited the file and said nothing is the ordinary shape of a
  // formatter or a shell script, so this is a statement, not an accusation. A
  // reply that arrived MANGLED reads completely differently, at full size,
  // where the reply would have been.
  if (turn.state === 'done') return turn.reply ? '' : 'finished with nothing said, the change is on the page';
  return TURN_LABEL[turn.state] || turn.state;
}

export function dotClass(state) {
  if (RUNNING.has(state)) return 'working';
  if (state === 'done') return 'done';
  if (state === 'error') return 'error';
  return '';
}

export const clock = iso => {
  const t = iso ? new Date(iso) : null;
  return t && !isNaN(t) ? t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
};

export const firstLine = text => (String(text || '').split('\n')[0].trim().slice(0, 72) || 'an empty comment');

// tag, then the id if there is one, else the first class: what the eyebrow and
// the list rows both call the element a comment is about.
export function elementLabel(target, kind) {
  const t = target || {};
  const tag = t.tag || kind || 'element';
  if (t.id) return tag + '#' + t.id;
  if (t.classes && t.classes.length) return tag + '.' + t.classes[0];
  return tag;
}

// The clipboard, with the textarea fallback for a page whose async API refuses.
export function copyText(text, done, fail) {
  const fallback = () => {
    const ta = chrome(el('textarea'));
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    ok ? done() : fail?.();
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

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

export function createPopover({ pen, thread, prefs, toast, onChange, anchor, step }) {
  const pop = chrome(el('div', 'rprPop rpPop'));
  pop.hidden = true;
  pop.dataset.rpTheme = 'light';

  const eyebrow = el('span', 'rprEyebrow');
  const moreBtn = el('button', 'rprX rpPopMore');
  moreBtn.innerHTML = renderIcon(iconMore, { size: 16 });
  moreBtn.title = 'More';
  moreBtn.setAttribute('aria-label', 'More');
  const closeBtn = el('button', 'rprX rpPopClose');
  closeBtn.innerHTML = renderIcon(iconClose, { size: 16 });
  closeBtn.title = 'Close';
  closeBtn.setAttribute('aria-label', 'Close');
  const top = el('div', 'rprTop rpPopTop');
  top.append(eyebrow, moreBtn, closeBtn);

  const menu = el('div', 'rpPopMenu');
  menu.hidden = true;
  const resolveAct = el('button', null, 'Resolve');
  resolveAct.dataset.act = 'resolve';
  const copyAct = el('button', null, 'Copy this comment');
  copyAct.dataset.act = 'copy';
  const deleteAct = el('button', 'danger', 'Delete…');
  deleteAct.dataset.act = 'delete';
  menu.append(resolveAct, copyAct, deleteAct);

  const was = el('div', 'rprWas');
  was.hidden = true;
  const wasLabel = el('b', null, 'answered when the question read');
  const wasText = el('span');
  // Without this the export can never say "they read the new wording and stood by
  // it": staying silent and never opening it look identical to whoever reads the
  // paste. Re-affirming restamps the stored question, which clears `stale`.
  const stillBtn = el('button', 'rprStill', 'still stands');
  was.append(wasLabel, wasText, stillBtn);

  const question = el('p', 'rprQ');
  question.hidden = true;
  const threadBox = el('div', 'rprThread');
  threadBox.hidden = true;
  const field = el('textarea', 'rpField');
  field.placeholder = 'what\'s wrong here';

  const foot = el('div', 'rprFoot rpPopFoot');
  const leftBtn = el('button', 'rpLeft', '‹ prev');
  const spacer = el('span', 'rprSpacer');
  const hint = el('span', 'rprHint', '⌘↵ done');
  const rightBtn = el('button', 'rpRight', 'comment');
  foot.append(leftBtn, spacer, hint, rightBtn);

  // The thread scrolls; the composer and the footer sit outside it, so the send
  // button never scrolls away and the popover's height stays bounded — which is
  // what keeps place()'s above/below flip working.
  pop.append(top, menu, was, question, threadBox, field, foot);
  document.body.appendChild(pop);

  let open = null;     // {kind:'ask', key, answerAtOpen} | {kind:'comment', id, …}
  let opened = null;   // the field's value when it was opened
  let dragged = false;

  const noteById = id => pen.items().find(n => n.id === id) || null;
  const openNoteId = () => (open && open.kind === 'comment' ? open.id : null);
  const transportCan = name => {
    const t = thread.transport();
    return !!(t && typeof t[name] === 'function');
  };

  // ---------- placement ----------

  function place(node) {
    const r = tailRect(node);
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(r.left, innerWidth - w - 16);
    left = Math.max(16, left);
    let top2 = r.bottom + 8;
    if (top2 + h > innerHeight - 16) top2 = Math.max(16, r.top - h - 8);
    pop.style.left = left + 'px';
    pop.style.top = top2 + 'px';
  }

  // A popover with nowhere to point still has to be reachable: with no anchor it
  // parks above the dock rather than being revealed at whatever its static
  // position happens to be, which is usually off-screen.
  function atDock() {
    const node = anchor && anchor();
    const r = node ? node.getBoundingClientRect() : { right: innerWidth - 14, top: innerHeight - 14 };
    pop.style.left = Math.max(16, r.right - pop.offsetWidth) + 'px';
    pop.style.top = Math.max(16, r.top - pop.offsetHeight - 8) + 'px';
  }

  function show(node) {
    pop.hidden = false;
    if (node) afterScroll(node, () => place(node));
    else atDock();
  }

  function relayout() {
    if (pop.hidden || !open || dragged) return;
    if (open.kind === 'ask') {
      const node = document.getElementById(open.key);
      if (node) place(node);
      return;
    }
    const note = noteById(open.id);
    const sel = note && note.target && note.target.selector;
    const node = sel ? document.querySelector(sel) : null;
    if (node) place(node);
  }

  // ---------- dragging ----------

  let drag = null;

  top.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = pop.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  });

  function onDragMove(e) {
    if (!drag) return;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(e.clientX - drag.dx, innerWidth - w - 8)) + 'px';
    pop.style.top = Math.max(8, Math.min(e.clientY - drag.dy, innerHeight - h - 8)) + 'px';
  }

  function onDragEnd() {
    if (!drag) return;
    drag = null;
    dragged = true;
  }

  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);

  // ---------- the field ----------

  // Writing only on a real edit is not an optimization. An answer stores the
  // question it was replying to, so an unconditional write on close would restamp
  // a STALE answer with the new wording just because it was looked at, quietly
  // erasing the fact that it answered a different question.
  function flush(force) {
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
  field.addEventListener('input', () => flush());

  // ---------- opening ----------

  function openAsk(k) {
    leaveOpen();
    const list = pen.requests();
    const r = list.find(x => x.key === k);
    if (!r) return hide();
    open = { kind: 'ask', key: k, answerAtOpen: r.answer || '' };
    thread.reading(null);
    pen.openRequest(k);
    closeMenu();
    moreBtn.hidden = true;
    eyebrow.textContent = `ask ${r.n} of ${list.length}`;
    question.hidden = false;
    question.textContent = r.ask;
    was.hidden = !r.stale;
    wasText.textContent = r.askedWas || '';
    renderThread();
    field.hidden = false;
    field.placeholder = 'your answer';
    field.value = opened = r.answer || '';
    leftBtn.hidden = false;
    leftBtn.textContent = '‹ prev';
    rightBtn.textContent = 'next ›';
    // Reset, not just unhidden: a threaded comment leaves it saying `send`, and
    // in here ⌘↵ steps to the next question.
    hint.textContent = '⌘↵ next';
    hint.hidden = false;
    dragged = false;
    show(document.getElementById(k));
    field.focus();
    onChange();
  }

  function openComment(item, { fresh = false } = {}) {
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
    open = { kind: 'comment', id: item.id, textAtOpen: item.text || '', threaded, fresh };
    thread.reading(item.id);
    pen.openRequest(null);
    closeMenu();
    moreBtn.hidden = false;
    resolveAct.textContent = item.resolved ? 'Reopen' : 'Resolve';
    eyebrow.textContent = 'comment';
    question.hidden = true;
    was.hidden = true;
    renderThread();
    field.hidden = false;
    field.placeholder = threaded ? 'reply to the agent…' : 'what\'s wrong here';
    field.value = opened = (threaded ? item.draft : item.text) || '';
    leftBtn.hidden = true;
    // Sending is asymmetric on purpose. The first message still goes on leaving
    // the popover, which is the flow this whole tool is built around: tap, type,
    // tap the next thing. A follow-up is explicit, because by then you are in a
    // conversation and pressing Escape must not send.
    rightBtn.textContent = threaded ? 'send ›' : 'comment';
    hint.hidden = false;
    hint.textContent = threaded ? '⌘↵ send' : '⌘↵ done';
    dragged = false;
    const sel = item.target && item.target.selector;
    show(sel ? document.querySelector(sel) : null);
    // renderThread ran while the popover was still hidden, because place() has to
    // measure a filled one. Nothing inside a hidden element has a scroll height,
    // so the newest exchange is only reachable once it is on screen.
    scrollThreadToEnd();
    field.focus();
    onChange();
  }

  function hide() {
    pop.hidden = true;
    if (document.activeElement === field) field.blur();
    thread.reading(null);
    pen.openRequest(null);
    onChange();
  }

  // The list can delete the comment that is open. The box has nothing left to
  // write to, so it closes without announcing.
  function closeIf(id) {
    if (!open || open.kind !== 'comment' || open.id !== id) return;
    open = null;
    hide();
  }

  // Chips render before the store has read, so a question can be opened while
  // its stored answer is still in flight, showing an empty field for a question
  // that was already answered. Re-seed on arrival, but never over typing.
  function reseed() {
    if (!open || open.kind !== 'ask' || field.value !== opened) return;
    const r = pen.requests().find(x => x.key === open.key);
    if (r) field.value = opened = open.answerAtOpen = r.answer || '';
  }

  // ---------- the ways out ----------

  // A comment is announced when it is sent for the first time, and never again.
  // Comments are reopenable, so without the guard pressing the button on one that
  // already went out would send it again and cost a second edit to the file. Once
  // a thread exists the first message is already gone and the comment text is
  // frozen, which is what makes the thread check sufficient on its own. A draft
  // left behind earlier, or any threadless comment while the wire is up, has
  // never gone out, so it sends even when this visit changed nothing.
  function shouldAnnounce(at, note) {
    if (note.thread && note.thread.length) return false;
    return note.text !== at.textAtOpen || drafted.has(at.id) || thread.connected();
  }

  // Only the comment button and ⌘↵ send a first message. Clicking away, starting
  // the next comment or opening a question leaves it as a draft in the field,
  // and the dock's Send ships every draft at once.
  const drafted = new Set();

  function leaveOpen({ send = false } = {}) {
    const at = open;
    flush();
    open = null;
    thread.reading(null);
    if (!at || at.kind !== 'comment') return;
    const note = noteById(at.id);
    if (!note) return;
    const threaded = !!(note.thread && note.thread.length);
    if (!threaded && !String(note.text || '').trim()) { pen.remove(at.id); return; }
    if (!send || prefs.hold()) { drafted.add(at.id); return; }
    if (shouldAnnounce(at, note)) thread.announce(at.id);
    drafted.delete(at.id);
  }

  // Escape only: put back what this visit changed, send nothing.
  function cancelOpen() {
    const at = open;
    open = null;
    if (!at) return hide();
    if (at.kind === 'ask') { pen.answer(at.key, at.answerAtOpen); return hide(); }
    if (at.kind !== 'comment') return hide();
    const note = noteById(at.id);
    if (!note) return hide();
    const threaded = !!(note.thread && note.thread.length);
    if (at.fresh && !threaded) {
      pen.remove(at.id);
      hide();
      if (String(note.text || '').trim()) toast(`comment ${at.id} discarded`, () => pen.restore([note]));
      return;
    }
    if (threaded) pen.updateNote(at.id, n => { delete n.draft; });
    else pen.setNote(at.id, at.textAtOpen);
    hide();
  }

  function leave(opts) { leaveOpen(opts); hide(); }
  function cancel() { cancelOpen(); }

  function finish() {
    if (!open) return;
    if (open.kind === 'ask') return step(1);
    if (open.kind === 'comment' && open.threaded) return sendFollowUp();
    leave({ send: true });
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
    onChange();
  }

  // ---------- the per-comment menu ----------

  function closeMenu() {
    menu.hidden = true;
    menu.textContent = '';
    menu.append(resolveAct, copyAct, deleteAct);
  }

  moreBtn.addEventListener('click', () => {
    if (!open || open.kind !== 'comment') return;
    if (!menu.hidden) return closeMenu();
    closeMenu();
    menu.hidden = false;
  });

  // Resolving closes: the comment has left the page, so leaving the popover open
  // on it would be showing you something that is no longer there. `open` is
  // cleared first for the same reason discard clears it — resolving is not a way
  // of finishing a comment, and must not send one.
  resolveAct.addEventListener('click', () => {
    if (!open || open.kind !== 'comment') return;
    const id = open.id;
    const note = noteById(id);
    if (!note) return;
    if (note.resolved) {
      thread.resolve(id, false);
      resolveAct.textContent = 'Resolve';
      closeMenu();
      onChange();
      return;
    }
    flush();
    open = null;
    thread.reading(null);
    thread.resolve(id, true);
    closeMenu();
    hide();
  });

  copyAct.addEventListener('click', () => {
    if (!open || open.kind !== 'comment') return;
    const item = pen.review().items.find(i => i.kind === 'comment' && i.id === open.id);
    if (!item) return;
    copyText(JSON.stringify(item, null, 2), () => {
      copyAct.textContent = 'copied ✓';
      setTimeout(() => { copyAct.textContent = 'Copy this comment'; }, 1500);
    });
  });

  deleteAct.addEventListener('click', () => {
    if (!open || open.kind !== 'comment') return;
    const id = open.id;
    const row = el('div', 'rpConfirm');
    row.append(document.createTextNode(`Delete comment ${id}?`), el('span', 'sp'));
    const no = el('button', null, 'cancel');
    no.addEventListener('click', closeMenu);
    const yes = el('button', 'go', 'delete');
    yes.addEventListener('click', () => discard(id));
    row.append(no, yes);
    menu.textContent = '';
    menu.appendChild(row);
  });

  // Resolve deliberately does not cancel: it means you are done reading. Discard
  // means this should not have happened, which is the one gesture that earns the
  // ask. It is still refused once the agent is landing, so the edit can arrive
  // anyway.
  function discard(id) {
    const note = noteById(id);
    const running = (note && note.thread || []).find(t => CANCELLABLE.has(t.state));
    if (running && transportCan('cancel')) thread.transport().cancel(running.request);
    // cleared first, so nothing writes the discarded text back on the way out
    open = null;
    thread.reading(null);
    pen.remove(id);
    closeMenu();
    hide();
    if (note) toast(`comment ${id} deleted`, () => pen.restore([note]));
  }

  stillBtn.addEventListener('click', () => {
    if (!open || open.kind !== 'ask' || !field.value.trim()) return;
    flush(true);
    openAsk(open.key);
  });

  closeBtn.addEventListener('click', leave);
  rightBtn.addEventListener('click', finish);
  leftBtn.addEventListener('click', () => step(-1));

  // ---------- the thread ----------

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
      btn.addEventListener('click', () => thread.transport().cancel(turn.request));
      row.append(btn);
    } else if (parked) {
      const btn = el('button', null, 'send');
      btn.addEventListener('click', () => { thread.resume(openNoteId(), turn.id); renderThread(); });
      row.append(btn);
    }
    return row;
  }

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
    const t = thread.transport();
    const them = (t && t.label) || 'agent';
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

  function onTurn(noteId) {
    if (openNoteId() === noteId) renderThread();
  }

  // Belt and braces now that every keystroke writes: this only has anything to do
  // when the field changed without firing `input`. It cannot make an in-flight
  // IndexedDB write commit, so it shortens the exposure rather than removing it.
  const onPageHide = () => flush();
  window.addEventListener('pagehide', onPageHide);

  return {
    node: pop,
    openAsk,
    openComment,
    openAt: () => open,
    isOpen: () => !pop.hidden,
    flush,
    leave,
    cancel,
    finish,
    hide,
    closeIf,
    reseed,
    relayout,
    onTurn,
    theme: v => { pop.dataset.rpTheme = v; },
    destroy() {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
      window.removeEventListener('pagehide', onPageHide);
      pop.remove();
    },
  };
}
