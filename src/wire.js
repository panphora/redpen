// wire.js — redpen's comments over clay.wire.
//
// Transport only, and a separate bundle: it attaches to a review that
// redpen-review.js already mounted, so a page that wants review without an agent
// loads exactly what it loads today.
//
//   const review = RedpenReview.mount({});
//   RedpenWire.attach(review);
//
// HTML never rides the wire. A local process answers with words and edits the
// FILE, and that edit reaches this page as an ordinary external change through
// live-sync, which is why nothing here touches the DOM the agent is writing
// about, and why a finished request is not the same event as a visible change.
//
// This file creates no DOM and owns no state about the conversation. It turns a
// request into a payload, and a stream of wire frames into the four calls
// review.js understands. That split is not decoration: picking a reply out of a
// stream of status lines takes knowing that stdout is the only channel, that
// frames arrive one at a time, that `rec.text` is sticky across state changes
// and that the line is cut at 4 KB of bytes — every one of which is a fact about
// the wire and none of which belongs in the review adapter.

// One attachment per page: a second would leave the first's subscription live
// with nothing able to remove it.
let attached = null;

const RUNNING = new Set(['sent', 'acked', 'landing']);

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

/**
 * What one status line turned out to be.
 *
 * A reply is one line on stdout that parses as a JSON object carrying a `redpen`
 * key. The sentinel is what stops a handler that pipes `jq` or an HTTP response
 * to stdout from having its tool output silently adopted as the agent's words.
 *
 *   {"redpen":1,"reply":"Cut the second clause."}
 *
 * `redpen` goes first by convention, because a line cut at the 4 KB limit keeps
 * its head, and that head is the only thing the mangled rule can match on.
 *
 * → { kind: 'progress' | 'reply' | 'mangled' | 'broken', text, append }
 */
export function decode(line) {
  const raw = String(line ?? '');
  // The fast path, and almost every line takes it.
  if (raw.trimStart()[0] !== '{') return { kind: 'progress', text: raw };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // It was MEANT to be a reply and did not survive the trip. Saying so is the
    // difference between a lost reply and an agent that had nothing to say.
    // Anywhere in what survived, not only at the head: `redpen` first is a
    // convention, and a truncated reply that put it second was being shown as a
    // giant line of raw JSON with no sign that a reply had been lost. The line
    // already starts with `{` and already failed to parse, so a false positive
    // here costs a wrong note rather than a wrong reply.
    if (/"redpen"\s*:/.test(raw)) return { kind: 'mangled', text: raw };
    return { kind: 'progress', text: raw };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'progress', text: raw };
  if (!Object.prototype.hasOwnProperty.call(parsed, 'redpen')) return { kind: 'progress', text: raw };
  // Marked as a reply and carrying nothing. A handler bug that eats the reply
  // has to look different from silence.
  if (typeof parsed.reply !== 'string' || !parsed.reply) return { kind: 'broken', text: raw };
  return { kind: 'reply', text: parsed.reply, append: parsed.append === true };
}

/**
 * One request's payload. `said` is ALWAYS the newest message, so a handler
 * written before threads existed reads `payload.said` and gets the current
 * instruction with no change at all.
 *
 * On turn one the result is byte-identical to what redpen sent before threads:
 * `turn` and `thread` appear only from the second exchange onwards.
 */
export function payloadFor(request) {
  const item = request.item || null;
  const projection = request.projection || {};
  const history = request.history || null;
  // The item carries the thread too, and shipping it inside the payload as well
  // would send the whole conversation twice.
  const { thread, ...bare } = item || {};
  const selector = item && item.anchor && item.anchor.selector;
  const el = selector ? document.querySelector(selector) : null;
  return {
    kind: 'comment',
    page: projection.page,
    said: request.ask,
    ...(request.turn > 1 ? { turn: request.turn } : {}),
    ...(history ? {
      thread: history.pairs,
      ...(history.earlier ? { earlier: history.earlier } : {}),
    } : {}),
    item: item ? bare : null,
    // The coordinate rule travels with the item, because the item's geometry is
    // expressed in that rule and reads as fractions of the wrong box without it.
    ...(item && item.target_id
      ? { target: (projection.targets || {})[item.target_id] || null }
      : projection.coords ? { coords: projection.coords } : {}),
    ...(el ? { region: nearestKey(el) } : {}),
  };
}

function createTransport(wire) {
  let sink = null;
  let off = null;
  // Only ids this transport issued. A page can hold other wire traffic, and a
  // frame for a request redpen never sent is not redpen's to interpret.
  const mine = new Set();

  function onFrame(rec, frame) {
    if (!sink || !mine.has(rec.id)) return;
    // Intermediates only. A terminal reaches the thread through handle.done,
    // which clayjs settles for every outcome including the id clash that never
    // emits at all — so a change to its emit pattern can cost progress text but
    // can never leave a turn spinning forever.
    if (RUNNING.has(rec.state)) sink.state(rec.id, rec.state);

    // The frame is the exact new line. `rec.text` is sticky across later states,
    // so a listener without the frame cannot tell a new line from the same line
    // arriving again — which is why clayjs passes it, and why the fallback below
    // is bounded to the one emit that can be a status line on an older build.
    const line = frame && typeof frame.text === 'string'
      ? frame.text
      : (rec.state === 'acked' && rec.text ? rec.text : '');
    if (!line) return;

    const said = decode(line);
    if (said.kind === 'reply') return void sink.reply(rec.id, said.text, { append: said.append });
    if (said.kind === 'mangled') {
      sink.progress(rec.id, said.text);
      return void sink.note(rec.id, 'the agent sent a reply that did not survive the trip');
    }
    if (said.kind === 'broken') {
      sink.progress(rec.id, said.text);
      return void sink.note(rec.id, 'the agent marked a reply that carried no words');
    }
    sink.progress(rec.id, said.text);
  }

  return {
    label: 'agent',
    attach(s) {
      sink = s;
      off = wire.on(onFrame);
    },
    detach() {
      off?.();
      off = null;
      sink = null;
      mine.clear();
      if (attached && attached.transport === this) attached = null;
    },
    // redpen mints the id, because clayjs emits the first frame from inside
    // send(): a mapping built from the return value would be built too late to
    // route it.
    send(request) {
      const handle = wire.send(payloadFor(request), { id: request.id, text: request.ask });
      if (!handle || !handle.id) return null;
      mine.add(handle.id);
      // The rejection arm matters as much as the other one: an unsettled `done`
      // leaves review.js holding the wire for a request that will never end, and
      // an error nobody reports is the one shape that cannot be waited out.
      handle.done.then(
        final => { mine.delete(handle.id); sink?.state(handle.id, final.state, final.error); },
        err => {
          mine.delete(handle.id);
          sink?.state(handle.id, 'error', err && err.message ? err.message : 'the wire failed');
        },
      );
      return { id: handle.id };
    },
    // clayjs refuses a cancel that arrived too late, so the rule lives there
    // rather than being restated here where the two could quietly disagree.
    cancel: id => wire.cancel(id),
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
    // Attaching the same review twice is idempotent, which is what lets a page
    // call attach() from more than one place without arranging who goes first.
    if (attached.review !== review) console.warn('[redpen] the wire is already attached to this page');
    return attached;
  }

  const transport = opts.transport || createTransport(wire);
  const disconnect = review.thread.connect(transport);

  attached = {
    review,
    transport,
    send: request => transport.send(request),
    detach() {
      // review.js owns the pill and the conversation, so this is what takes both
      // of them down; the transport's own detach clears `attached`.
      disconnect();
      attached = null;
    },
  };
  return attached;
}
