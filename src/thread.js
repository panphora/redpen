// thread.js — the conversation model behind a comment, and nothing else.
//
// A comment can hold a conversation. You say something, an agent answers in
// words and edits the file, and you answer that. The words live on the note as
// `note.thread`, one entry per exchange. The edit does not live here at all: it
// reaches the page as an ordinary external change to the file, through live
// sync, so a finished request and a visible change are two different events.
//
// This owns every piece of that state and knows nothing about clay.wire, and it
// creates no DOM. A transport is handed in, speaks in request ids, and calls
// back through `sink`. Turning a wire frame into one of those four calls is the
// transport's whole job, because picking a reply out of a stream of status lines
// takes knowledge of the wire that has no business in here.

const CAP = { line: 400, lines: 50, reply: 32 * 1024, say: 2000, pairs: 8, history: 16 * 1024 };
// has a request on the wire, versus is simply not finished. `queued` is the
// difference, and every rule below cares which one it is looking at.
export const RUNNING = new Set(['sent', 'acked', 'landing']);
export const UNFINISHED = new Set(['queued', 'parked', 'sent', 'acked', 'landing']);

export function createThread({ pen, listeners, prefs, onTurn }) {
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
  let opener = null;               // set by mount(); the way back into a comment
  const byRequest = new Map();     // request id -> { noteId, turnId }

  const now = () => new Date().toISOString();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function noteById(id) {
    return pen.items().find(n => n.id === id) || null;
  }

  const showTurn = (noteId, turnId) => onTurn?.(noteId, turnId);

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

  // What the thread hands the transport. Every method takes the request id, and
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
        // Two surfaces of increasing durability carry a reply that arrived while
        // you were elsewhere: this ring on the marker, and the stored flag that
        // survives a reload. Reading the thread is what clears it, so an open
        // popover was already read.
        // Typing a follow-up already brings a resolved comment back; so does
        // being answered. You retired it before you knew there were words
        // coming, and words you cannot reach are words you did not get.
        if (note.resolved) { delete note.resolved; back = true; }
        if (reading === note.id) return;
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
    // line becomes visible without the thread knowing what a status line is.
    note(requestId, line) {
      const said = cut(String(line ?? '').trim(), CAP.line);
      if (!said) return false;
      return withTurn(requestId, turn => { turn.note = said; });
    },
  };

  // Which comment is on screen right now, so a reply that lands while you are
  // reading it is already read. The popover sets it.
  let reading = null;

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
      console.warn('[redpen] the transport threw', err);
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
    t.detach?.();
    showTurn(null, null);
  }

  // A comment is announced when it is finished for the first time, and never
  // again. The popover's leave rule decides when that is; this is what it costs.
  function announce(id) {
    if (!listeners.size && !transport) return;
    // The whole projection, not just the item: an area note on a registered
    // target reads as fractions of the wrong box without the basis and coords
    // that live at the top of this envelope, and building a second per-item
    // projection here is how those two rules drift apart.
    const review = pen.review();
    const item = review.items.find(i => i.kind === 'comment' && i.id === id);
    // Whitespace is not a comment. The stored note keeps whatever was typed;
    // this is only about what counts as something to send.
    if (!item || !item.said || !item.said.trim()) return;
    for (const fn of [...listeners]) {
      try {
        fn(item, review);
      } catch (err) {
        console.warn('[redpen] onComment failed', err);
      }
    }
    // Turn one. A host listener and a transport are not alternatives: a page can
    // want its own copy of every comment AND an agent working on them, and the
    // announce guard has already established this note has no thread yet.
    sendTurn(id, item.said);
  }

  // What Send would ship: comments whose first message never went out, and
  // follow-up drafts on comments that did.
  function pending() {
    const comments = [], drafts = [];
    for (const n of pen.items()) {
      if (n.resolved) continue;
      const threaded = !!(n.thread && n.thread.length);
      if (!threaded && String(n.text || '').trim()) comments.push(n.id);
      else if (threaded && n.draft && n.draft.trim()) drafts.push(n.id);
    }
    return { comments, drafts, count: comments.length + drafts.length };
  }

  // One request each, in document order; sendTurn queues everything after the
  // first and drain() sends the rest as the wire frees up.
  function sendPending() {
    if (!transport || detachWhenIdle || !pen.loaded()) return 0;
    let started = 0;
    const p = pending();
    // A refusal is settled on the thread before sendTurn returns, so a turn
    // already in `error` was never on the wire.
    const went = (id, turnId) => {
      const t = (noteById(id)?.thread || []).find(x => x.id === turnId);
      return !!t && t.state !== 'error';
    };
    for (const id of p.comments) {
      const before = (noteById(id)?.thread || []).length;
      announce(id);
      const after = noteById(id)?.thread || [];
      if (after.length > before && went(id, after[after.length - 1].id)) started++;
    }
    for (const id of p.drafts) {
      const said = noteById(id).draft;
      pen.updateNote(id, n => { delete n.draft; });
      const turn = thread.send(id, said);
      if (turn && went(id, turn.id)) started++;
      else if (!turn) pen.updateNote(id, n => { n.draft = said; });
    }
    return started;
  }

  const thread = {
    // Returns its own disconnect, and refuses a second transport rather than
    // replacing the first: two would each believe they own `inflight`, and the
    // one-request rule is the only thing keeping two agents off one file.
    connect(t) {
      if (!t || typeof t.send !== 'function') return () => {};
      if (transport) {
        console.warn('[redpen] a transport is already connected');
        return () => {};
      }
      transport = t;
      t.attach?.(sink);
      showTurn(null, null);
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
      opener?.(noteId);
    },
    setOpener(fn) { opener = typeof fn === 'function' ? fn : null; },
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
    transport: () => transport,
    reading: id => { reading = id ?? null; },
    announce,
    pending,
    sendPending,
    sweepUnfinished,
    disconnect,
  };

  return thread;
}
