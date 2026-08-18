// wire.js — redpen's comments over clay.wire.
//
// Transport only, and a separate bundle: it attaches to a review that
// redpen-review.js already mounted, so a page that wants review without an agent
// loads exactly what it loads today.
//
//   const review = RedpenReview.mount({});
//   RedpenWire.attach(review);
//
// HTML never rides the wire. A local process answers with progress and edits the
// FILE, and that edit reaches this page as an ordinary external change through
// live-sync, which is why nothing here touches the DOM the agent is writing
// about, and why a finished request is not the same event as a visible change.

import { chrome, mark } from './mark.js';

const STYLES = `
  .rprWire { position: fixed; left: 14px; bottom: 14px; z-index: 99995; display: flex; align-items: center; gap: 8px;
    font-family: var(--mono, ui-monospace, "SF Mono", Menlo, monospace); font-size: 11.5px; letter-spacing: .06em;
    max-width: min(420px, calc(100vw - 28px));
    background: var(--card, #FDFDFC); border: 1px solid var(--line, #DCD8D2); border-radius: 7px; padding: 5px 8px; }
  .rprWire[hidden] { display: none; }
  .rprWire .rprWireDot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--ink-faint, #8A857E); }
  .rprWire.working .rprWireDot { background: var(--flag, #e5484d); animation: rprWirePulse 1.1s ease-in-out infinite; }
  .rprWire.done .rprWireDot { background: #2f9e44; }
  .rprWire.error .rprWireDot { background: var(--flag, #e5484d); }
  .rprWire .rprWireText { color: var(--ink, #17110C); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rprWire button { font: inherit; letter-spacing: inherit; color: var(--ink-faint, #8A857E); background: none;
    border: 0; border-radius: 5px; padding: 2px 6px; cursor: pointer; }
  .rprWire button:hover { color: var(--ink, #17110C); background: var(--line, #DCD8D2); }
  @keyframes rprWirePulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
`;

// In flight, so the pill stays up. `landing` is in here but NOT in CANCELLABLE:
// clayjs stops accepting a cancel once the handler has finished writing (its
// OPEN_STATES are sent and acked), so offering the button there is a button that
// does nothing.
// One attachment per page: a second would orphan the first pill and its wire
// listener, and the first detach could then remove neither.
let attached = null;

const WORKING = new Set(['sent', 'acked', 'landing']);
const CANCELLABLE = new Set(['sent', 'acked']);

const LABEL = {
  sent: 'sending to the agent',
  acked: 'the agent is working',
  landing: 'waiting for the change',
  done: 'done',
  cancelled: 'cancelled',
};

function injectStyles() {
  if (document.getElementById('rprWireStyle')) return;
  const style = mark(document.createElement('style'));
  style.id = 'rprWireStyle';
  style.textContent = STYLES;
  document.head.prepend(style);
}

// The key spliceProtected places an incoming disk frame by: synthetic identity
// first, then data-id, then id. A dirty root with no usable key holds the whole
// frame back, so the agent is told which region it is editing inside rather than
// finding out by having its work silently not appear.
export function nearestKey(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const dataId = node.getAttribute('data-id');
    const id = node.getAttribute('id');
    if (dataId) return { key: dataId, selector: `[data-id="${CSS.escape(dataId)}"]`, tag: node.tagName.toLowerCase() };
    if (id) return { key: id, selector: `#${CSS.escape(id)}`, tag: node.tagName.toLowerCase() };
  }
  return null;
}

// One item's projection, never the whole page's. The coordinate rule travels
// with it because the item's geometry is expressed in that rule and reads as
// fractions of the wrong box without it.
export function payloadFor(item, projection) {
  const selector = item.anchor && item.anchor.selector;
  const el = selector ? document.querySelector(selector) : null;
  return {
    kind: 'comment',
    page: projection.page,
    said: item.said,
    item,
    ...(item.target_id
      ? { target: (projection.targets || {})[item.target_id] || null }
      : projection.coords ? { coords: projection.coords } : {}),
    ...(el ? { region: nearestKey(el) } : {}),
  };
}

/**
 * Attach a transport to a mounted review.
 *
 * Returns null when there is no wire — a page opened from file://, or one whose
 * clayjs was loaded without the plugin. That is the ordinary case for a review
 * page with no agent, and it must leave copy-JSON working rather than throw.
 */
export function attach(review, opts = {}) {
  const wire = window.clay && window.clay.wire;
  // Every method this uses, not just send: an older or partial wire that lacks
  // `on` would throw here, and not throwing is the whole contract of this guard.
  if (!wire || typeof wire.send !== 'function' || typeof wire.on !== 'function') {
    console.warn('[redpen] no clay.wire on this page: comments stay in the clipboard');
    return null;
  }

  if (attached) {
    console.warn('[redpen] the wire is already attached to this page');
    return attached;
  }

  injectStyles();

  const pill = chrome(document.createElement('div'));
  pill.className = 'rprWire';
  pill.hidden = true;
  const dot = document.createElement('span');
  dot.className = 'rprWireDot';
  const text = document.createElement('span');
  text.className = 'rprWireText';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'cancel';
  pill.append(dot, text, cancelBtn);
  document.body.appendChild(pill);

  let showing = null;
  let clearTimer = null;

  function render(rec) {
    if (!rec) return;
    showing = rec;
    clearTimeout(clearTimer);
    const working = WORKING.has(rec.state);
    pill.hidden = false;
    pill.classList.toggle('working', working);
    pill.classList.toggle('done', rec.state === 'done');
    pill.classList.toggle('error', rec.state === 'error');
    // The status line is the agent's own words and clayjs never clears it, so a
    // request that reaches landing or done would otherwise keep showing whatever
    // it was doing three frames ago.
    text.textContent = rec.state === 'error'
      ? (rec.error || 'the agent failed')
      : (CANCELLABLE.has(rec.state) && rec.text) || LABEL[rec.state] || rec.state;
    cancelBtn.hidden = !CANCELLABLE.has(rec.state);
    // A finished request stops being news. An error stays until the next one, so
    // a failure cannot scroll past unread.
    if (rec.state === 'done' || rec.state === 'cancelled') {
      clearTimer = setTimeout(() => { pill.hidden = true; showing = null; }, 2500);
    }
  }

  const off = wire.on(rec => {
    // The newest request owns the pill: an older one still finishing would
    // otherwise overwrite the state of the one just sent.
    if (!showing || rec.id === showing.id || !WORKING.has(showing.state)) render(rec);
  });

  cancelBtn.addEventListener('click', () => {
    if (showing && CANCELLABLE.has(showing.state)) wire.cancel(showing.id);
  });

  const send = (item, projection) => {
    const handle = wire.send(payloadFor(item, projection), { text: item.said });
    render({ id: handle.id, state: 'sent', text: '', error: null });
    return handle;
  };

  // Its own subscription, and detach removes only that one: a second attachment,
  // or a listener the page installed through mount(), must survive this one
  // going away.
  const offComment = review.onComment(typeof opts.onComment === 'function' ? opts.onComment : send);

  attached = {
    send,
    detach() {
      off();
      offComment();
      clearTimeout(clearTimer);
      pill.remove();
      document.getElementById('rprWireStyle')?.remove();
      attached = null;
    },
  };
  return attached;
}
