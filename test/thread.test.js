import { expect } from '@esm-bundle/chai';
import { mount } from '../src/review.js';

// The thread's preconditions: a comment you can get back into, and a popover you
// can leave without re-sending what is inside it. Everything else in the thread
// is built on these two.

const FIXTURE = `
<main>
  <section id="s1">
    <p style="height: 60px">Something the page says about itself.</p>
  </section>
</main>`;

let review = null;

const pop = () => document.querySelector('.rprPop');

const footBtn = label =>
  [...pop().querySelectorAll('.rprFoot button')].find(b => b.textContent.startsWith(label));

const topBtn = label =>
  [...pop().querySelectorAll('.rprTop button')].find(b => b.textContent === label);

function tapComment() {
  review.point(true);
  const overlay = document.getElementById('laOverlay');
  const r = document.querySelector('main p').getBoundingClientRect();
  const at = {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
    clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
  };
  overlay.dispatchEvent(new PointerEvent('pointerdown', at));
  overlay.dispatchEvent(new PointerEvent('pointerup', at));
}

function say(words) {
  const field = pop().querySelector('textarea');
  field.value = words;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

// A comment that exists, is written, and is closed: the state every test below
// starts from. Point mode goes off the way a reader turns it off, so the capture
// overlay is not sitting over the markers.
function madeComment(words) {
  tapComment();
  say(words);
  footBtn('done').click();
  review.point(false);
}

const marker = () => document.querySelector('.laMarkers [data-la-note]');

// An element note draws a box with a dot in its corner and a point note draws
// the dot alone, so the dot is the tag or the marker itself.
const dot = () => {
  const el = marker();
  return el && (el.querySelector('.tag') || el);
};

const clickMarker = () => {
  dot().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

const ringing = () => dot().classList.contains('unread');

// The store prefers IndexedDB, and every backend it opens keeps its connection
// for the life of the page, so `deleteDatabase` between tests is not available:
// it blocks forever and every later open queues behind it. Each test gets its
// own instance key instead, which is a different blob under the same database.
// A transport that records instead of sending, and hands back the sink so a test
// can play the agent. `refuse` is the transport that cannot send at all.
function fakeTransport({ refuse = false } = {}) {
  const t = {
    label: 'fake',
    sent: [],
    cancelled: [],
    sink: null,
    attach(sink) { t.sink = sink; },
    detach() { t.sink = null; },
    send(request) {
      t.sent.push(request);
      return refuse ? null : { id: request.id };
    },
    cancel(id) { t.cancelled.push(id); return true; },
  };
  return t;
}

// The store's read is async and a turn written before it lands is erased by it.
// Wait on the engine's own signal rather than a timer: a fixed sleep is a bet on
// how long IndexedDB takes to open, and the first open on a cold profile loses
// that bet, which shows up as tests failing in the shape of product bugs.
const loaded = () => new Promise(resolve => {
  if (review.pen.loaded()) return resolve();
  review.pen.addEventListener('change', function once(e) {
    if (!e.detail || e.detail.action !== 'load') return;
    review.pen.removeEventListener('change', once);
    resolve();
  });
});

const threadOf = id => review.thread.of(id);
const onlyNote = () => review.json().items.find(i => i.kind === 'comment');

const turns = () => [...pop().querySelectorAll('.rprThread .rprTurn')];
const textOf = (root, sel) => [...root.querySelectorAll(sel)].map(n => n.textContent);
const pill = () => document.querySelector('.rprWire');
const barBtn = label =>
  [...document.querySelectorAll('.rprBar button')].find(b => b.textContent === label);

// a comment with one exchange behind it, which is where the thread's UI starts
async function threaded(key, said = 'make this shorter') {
  review = mount({ key });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment(said);
  return wire;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = FIXTURE;
});

afterEach(() => {
  review?.destroy();
  review = null;
  document.body.innerHTML = '';
});

it('a marker tag reopens the comment it belongs to', () => {
  review = mount({ key: 'test:reopen' });
  madeComment('this paragraph should say more');

  expect(pop().hidden).to.equal(true);
  clickMarker();

  expect(pop().hidden).to.equal(false);
  expect(pop().querySelector('textarea').value).to.equal('this paragraph should say more');
});

// The one that matters. leaveOpen runs on every way out of the popover and used
// to announce unconditionally, which was safe only while a comment could never
// be reopened. Now that it can, an unguarded announce would send the comment to
// the agent again and cost a second edit to the file, every time you looked at a
// reply.
it('reopening a comment and closing it unchanged says nothing', () => {
  review = mount({ key: 'test:reopen-silent' });
  const seen = [];
  review.onComment(item => seen.push(item));

  madeComment('this paragraph should say more');
  expect(seen.length).to.equal(1);

  clickMarker();
  footBtn('done').click();

  expect(seen.length).to.equal(1);
});

it('reopening a comment that was never sent, and editing it, does announce', () => {
  review = mount({ key: 'test:reopen-edit' });
  const seen = [];
  review.onComment(item => seen.push(item));

  madeComment('first thought');
  clickMarker();
  say('second thought');
  footBtn('done').click();

  expect(seen.length).to.equal(2);
  expect(seen[1].said).to.equal('second thought');
});

// Once a thread exists the first message is already with the agent and the
// comment text is frozen, so nothing that happens in the popover can re-send it.
it('a comment that already has a thread never announces again', () => {
  review = mount({ key: 'test:threaded' });
  const seen = [];
  review.onComment(item => seen.push(item));

  madeComment('shorten this');
  expect(seen.length).to.equal(1);

  const id = review.json().items.find(i => i.kind === 'comment').id;
  review.pen.updateNote(id, note => {
    note.thread = [{ id: 't1', ask: 'shorten this', state: 'done', reply: 'done that' }];
  });

  // once a thread exists the footer sends follow-ups, so leaving is the × — and
  // leaving is the gesture that used to announce
  clickMarker();
  say('shorten this a lot');
  topBtn('×').click();

  expect(seen.length).to.equal(1);
});

it('a resolved comment leaves the page, and comes back when it is reopened', () => {
  review = mount({ key: 'test:resolved-marker' });
  madeComment('shorten this');
  expect(marker()).to.not.equal(null);

  const id = review.json().items.find(i => i.kind === 'comment').id;
  review.pen.updateNote(id, note => { note.resolved = new Date().toISOString(); });
  review.pen.layout();
  expect(marker()).to.equal(null);

  review.pen.updateNote(id, note => { delete note.resolved; });
  review.pen.layout();
  expect(marker()).to.not.equal(null);
});

it('a resolved comment still exports, and is counted', () => {
  review = mount({ key: 'test:resolved-export' });
  madeComment('shorten this');

  const id = review.json().items.find(i => i.kind === 'comment').id;
  const at = new Date().toISOString();
  review.pen.updateNote(id, note => { note.resolved = at; });

  const out = review.json();
  const item = out.items.find(i => i.kind === 'comment');
  expect(item.resolved).to.equal(at);
  expect(out.resolved).to.equal(1);
});

// The store round-trips a note's unknown fields verbatim, in both directions,
// which is the whole reason the thread needs no store version bump.
it('a thread survives a store round trip without bumping the blob version', async () => {
  review = mount({ key: 'test:roundtrip' });
  madeComment('shorten this');

  const id = review.json().items.find(i => i.kind === 'comment').id;
  review.pen.updateNote(id, note => {
    note.thread = [{ id: 't1', ask: 'shorten this', state: 'done', reply: 'cut the second clause' }];
  });

  // Wait for the write to reach the store, not for a fixed number of
  // milliseconds: a cold IndexedDB open takes longer than any sleep worth
  // writing, and the note simply was not there yet when the reload read it.
  await review.pen.flushed();
  review.destroy();

  review = mount({ key: 'test:roundtrip' });
  await loaded();

  const item = review.json().items.find(i => i.kind === 'comment');
  expect(item.thread.length).to.equal(1);
  expect(item.thread[0].reply).to.equal('cut the second clause');
});

// ---------- the thread model ----------

it('a finished comment starts turn one, written before the transport is called', async () => {
  review = mount({ key: 'test:turn-one' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  madeComment('make this shorter');

  expect(wire.sent.length).to.equal(1);
  const turns = threadOf(onlyNote().id);
  expect(turns.length).to.equal(1);
  expect(turns[0].ask).to.equal('make this shorter');
  expect(turns[0].state).to.equal('sent');
  expect(turns[0].request).to.equal(wire.sent[0].id);
  // turn one ships no history, so its payload is what it always was
  expect(wire.sent[0].history).to.equal(undefined);
  expect(wire.sent[0].turn).to.equal(1);
  expect(wire.sent[0].item.said).to.equal('make this shorter');
});

it('writes nothing before the store has read', () => {
  review = mount({ key: 'test:before-load' });
  const wire = fakeTransport();
  review.thread.connect(wire);

  expect(review.thread.send(1, 'too early')).to.equal(null);
  expect(wire.sent.length).to.equal(0);
});

it('walks a turn through the wire and stores what came back', async () => {
  review = mount({ key: 'test:walk' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  const id = onlyNote().id;
  const req = wire.sent[0].id;

  wire.sink.state(req, 'acked');
  wire.sink.progress(req, 'reading the file');
  wire.sink.progress(req, 'rewriting the intro');
  wire.sink.reply(req, 'Cut the second clause.');
  wire.sink.state(req, 'landing');
  wire.sink.state(req, 'done');

  const [turn] = threadOf(id);
  expect(turn.state).to.equal('done');
  expect(turn.reply).to.equal('Cut the second clause.');
  expect(turn.progress).to.deep.equal(['reading the file', 'rewriting the intro']);
  expect(turn.repliedAt).to.be.a('string');
  expect(turn.endedAt).to.be.a('string');
  expect(review.thread.busy()).to.equal(false);
});

it('a reply that lands while the popover is shut leaves the marker unread', async () => {
  review = mount({ key: 'test:unread' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');

  wire.sink.reply(wire.sent[0].id, 'done that');
  expect(ringing()).to.equal(true);

  clickMarker();
  expect(ringing()).to.equal(false);
});

it('a reply that lands while you are reading the thread is already read', async () => {
  review = mount({ key: 'test:unread-open' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  clickMarker();

  wire.sink.reply(wire.sent[0].id, 'done that');
  expect(ringing()).to.equal(false);
});

it('holds a second request behind the first, and sends it when the wire frees up', async () => {
  review = mount({ key: 'test:queue' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  const id = onlyNote().id;

  const second = review.thread.send(id, 'and drop the date');
  expect(second.state).to.equal('queued');
  expect(wire.sent.length).to.equal(1);

  wire.sink.state(wire.sent[0].id, 'done');

  expect(wire.sent.length).to.equal(2);
  expect(threadOf(id)[1].state).to.equal('sent');
  expect(wire.sent[1].ask).to.equal('and drop the date');
});

it('a follow-up carries the exchanges as you and agent pairs', async () => {
  review = mount({ key: 'test:history' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  const id = onlyNote().id;

  wire.sink.reply(wire.sent[0].id, 'Cut the second clause.');
  wire.sink.state(wire.sent[0].id, 'done');
  review.thread.send(id, 'two sentences, not three');

  expect(wire.sent[1].turn).to.equal(2);
  expect(wire.sent[1].history.earlier).to.equal(0);
  expect(wire.sent[1].history.pairs).to.deep.equal([
    { you: 'make this shorter', agent: 'Cut the second clause.' },
    { you: 'two sentences, not three' },
  ]);
});

it('an exchange that failed says so in the history', async () => {
  review = mount({ key: 'test:history-failed' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  const id = onlyNote().id;

  wire.sink.state(wire.sent[0].id, 'error', 'the handler exited 1');
  review.thread.send(id, 'try again');

  expect(wire.sent[1].history.pairs[0]).to.deep.equal({
    you: 'make this shorter', failed: 'the handler exited 1',
  });
});

it('keeps the last eight exchanges and counts the rest', async () => {
  review = mount({ key: 'test:history-cap' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('turn 1');
  const id = onlyNote().id;

  for (let n = 2; n <= 12; n++) {
    wire.sink.state(wire.sent[wire.sent.length - 1].id, 'done');
    review.thread.send(id, 'turn ' + n);
  }

  const { pairs, earlier } = wire.sent[wire.sent.length - 1].history;
  expect(pairs.length).to.equal(8);
  expect(earlier).to.equal(4);
  expect(pairs[0].you).to.equal('turn 5');
  expect(pairs[7].you).to.equal('turn 12');
});

it('caps a chatty handler rather than growing the blob', async () => {
  review = mount({ key: 'test:caps' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  const req = wire.sent[0].id;

  for (let n = 0; n < 60; n++) wire.sink.progress(req, 'line ' + n);
  wire.sink.progress(req, 'x'.repeat(900));
  wire.sink.reply(req, 'y'.repeat(40000));

  const [turn] = threadOf(onlyNote().id);
  expect(turn.progress.length).to.equal(50);
  expect(turn.progressDropped).to.equal(11);
  expect(turn.progress[turn.progress.length - 1].length).to.equal(400);
  expect(turn.reply.length).to.equal(32 * 1024);
});

it('a transport that refuses says so on the thread and frees the wire', async () => {
  review = mount({ key: 'test:refused' });
  await loaded();
  const wire = fakeTransport({ refuse: true });
  review.thread.connect(wire);
  madeComment('make this shorter');

  const [turn] = threadOf(onlyNote().id);
  expect(turn.state).to.equal('error');
  expect(turn.error).to.equal('this could not be sent');
  expect(review.thread.busy()).to.equal(false);
});

it('a frame for a comment that was discarded mid-request unwedges the queue', async () => {
  review = mount({ key: 'test:discarded' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  const first = onlyNote().id;
  const held = review.thread.send(first, 'and the date');
  expect(held.state).to.equal('queued');

  review.pen.remove(first);
  wire.sink.state(wire.sent[0].id, 'done');

  expect(review.thread.busy()).to.equal(false);
});

it('a turn still running when the page closed reads as unknown after the reload', async () => {
  review = mount({ key: 'test:swept' });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  wire.sink.reply(wire.sent[0].id, 'I rewrote the intro');
  await loaded();
  review.destroy();

  review = mount({ key: 'test:swept' });
  await loaded();
  const [turn] = threadOf(onlyNote().id);
  expect(turn.state).to.equal('unknown');
  expect(turn.endedAt).to.be.a('string');
  // what it managed to say before the page went away is still true
  expect(turn.reply).to.equal('I rewrote the intro');
});

it('a queued turn found after a reload waits to be sent by hand', async () => {
  review = mount({ key: 'test:swept-queue' });
  await loaded();
  const first = fakeTransport();
  review.thread.connect(first);
  madeComment('make this shorter');
  review.thread.send(onlyNote().id, 'and the date');
  await loaded();
  review.destroy();

  review = mount({ key: 'test:swept-queue' });
  const second = fakeTransport();
  review.thread.connect(second);
  await loaded();

  expect(threadOf(onlyNote().id)[1].state).to.equal('parked');
  expect(second.sent.length).to.equal(0);
});

it('a second transport is refused rather than replacing the first', async () => {
  review = mount({ key: 'test:one-transport' });
  await loaded();
  const first = fakeTransport();
  const second = fakeTransport();
  review.thread.connect(first);
  review.thread.connect(second);

  madeComment('make this shorter');
  expect(first.sent.length).to.equal(1);
  expect(second.sent.length).to.equal(0);
});

it('hands out a copy of the thread, not the stored one', async () => {
  review = mount({ key: 'test:frozen' });
  await loaded();
  review.thread.connect(fakeTransport());
  madeComment('make this shorter');
  const id = onlyNote().id;

  const turns = threadOf(id);
  try { turns[0].ask = 'something else'; } catch {}
  expect(threadOf(id)[0].ask).to.equal('make this shorter');
});

// ---------- the thread's chrome ----------

it('shows your words muted and the reply in full ink', async () => {
  const wire = await threaded('test:ui-turn');
  wire.sink.reply(wire.sent[0].id, 'Cut the second clause.');
  wire.sink.state(wire.sent[0].id, 'done');
  clickMarker();

  expect(turns().length).to.equal(1);
  expect(textOf(turns()[0], '.rprSaid')).to.deep.equal(['make this shorter']);
  expect(textOf(turns()[0], '.rprReply')).to.deep.equal(['Cut the second clause.']);
  expect(textOf(turns()[0], '.rprWho span:first-child')).to.deep.equal(['you', 'fake']);
});

it('splits a reply into paragraphs on a blank line and keeps single newlines', async () => {
  const wire = await threaded('test:ui-paras');
  wire.sink.reply(wire.sent[0].id, 'Cut the clause.\n\nThe heading\nis unchanged.');
  clickMarker();

  expect(textOf(turns()[0], '.rprReply')).to.deep.equal(['Cut the clause.', 'The heading\nis unchanged.']);
});

// The handler is a local process, but local stops meaning safe the moment that
// process is a model summarizing a document it just read.
it('never renders a reply as HTML', async () => {
  const wire = await threaded('test:ui-escape');
  wire.sink.reply(wire.sent[0].id, 'I removed the <b onclick="x()">bold</b> tag');
  clickMarker();

  const [para] = turns()[0].querySelectorAll('.rprReply');
  expect(para.querySelector('b')).to.equal(null);
  expect(para.textContent).to.equal('I removed the <b onclick="x()">bold</b> tag');
});

it('turns the comment field into the composer once a thread exists', async () => {
  const wire = await threaded('test:ui-composer');
  wire.sink.state(wire.sent[0].id, 'done');
  clickMarker();

  const composer = pop().querySelector('textarea');
  expect(composer.placeholder).to.equal('reply to the agent…');
  expect(composer.value).to.equal('');
  expect(footBtn('send').textContent).to.equal('send ›');
});

it('sends a follow-up on send, and clears the composer', async () => {
  const wire = await threaded('test:ui-send');
  wire.sink.state(wire.sent[0].id, 'done');
  clickMarker();
  say('two sentences, not three');
  footBtn('send').click();

  expect(wire.sent.length).to.equal(2);
  expect(wire.sent[1].ask).to.equal('two sentences, not three');
  expect(pop().querySelector('textarea').value).to.equal('');
  expect(turns().length).to.equal(2);
});

it('keeps an unsent follow-up as a draft, and never as the comment', async () => {
  const wire = await threaded('test:ui-draft');
  wire.sink.state(wire.sent[0].id, 'done');
  const id = onlyNote().id;
  clickMarker();
  say('half a thought');
  topBtn('×').click();

  expect(review.pen.items().find(n => n.id === id).draft).to.equal('half a thought');
  expect(onlyNote().said).to.equal('make this shorter');

  clickMarker();
  expect(pop().querySelector('textarea').value).to.equal('half a thought');
});

it('offers cancel while the agent is working, and not once it is landing', async () => {
  const wire = await threaded('test:ui-cancel');
  const req = wire.sent[0].id;
  wire.sink.state(req, 'acked');
  clickMarker();
  expect(textOf(pop(), '.rprTurnState button')).to.deep.equal(['cancel']);

  pop().querySelector('.rprTurnState button').click();
  expect(wire.cancelled).to.deep.equal([req]);

  wire.sink.state(req, 'landing');
  expect(textOf(pop(), '.rprTurnState button')).to.deep.equal([]);
});

it('says so when the agent finished without a word', async () => {
  const wire = await threaded('test:ui-silent');
  wire.sink.state(wire.sent[0].id, 'done');
  clickMarker();

  expect(pop().querySelector('.rprTurnState').textContent)
    .to.contain('finished with nothing said, the change is on the page');
});

it('a reply that arrived before the change says the change is still coming', async () => {
  const wire = await threaded('test:ui-landing');
  wire.sink.reply(wire.sent[0].id, 'I rewrote the intro');
  wire.sink.state(wire.sent[0].id, 'landing');
  clickMarker();

  expect(pop().querySelector('.rprTurnState').textContent).to.contain('answered, waiting for the change');
});

it('collapses the progress trail, and shows the newest line while it works', async () => {
  const wire = await threaded('test:ui-trail');
  const req = wire.sent[0].id;
  wire.sink.state(req, 'acked');
  wire.sink.progress(req, 'reading the file');
  wire.sink.progress(req, 'rewriting the intro');
  clickMarker();

  const trail = pop().querySelector('.rprTrail');
  expect(trail.open).to.equal(false);
  expect(trail.querySelector('summary').textContent).to.equal('2 progress lines');
  expect(textOf(turns()[0], '.rprSaid')).to.deep.equal(['make this shorter']);
  expect(textOf(turns()[0], '.rprNow')).to.deep.equal(['rewriting the intro']);
});

it('a queued turn left by a reload waits behind a send button', async () => {
  const first = await threaded('test:ui-stalled');
  review.thread.send(onlyNote().id, 'and drop the date');
  // The store writes behind the gesture, so the queued turn is in memory well
  // before it is on disk. This test is about what a RELOAD finds, so it has to
  // wait for the write and not merely for the load that preceded it.
  await review.pen.flushed();
  review.destroy();

  review = mount({ key: 'test:ui-stalled' });
  const wire = fakeTransport();
  review.thread.connect(wire);
  await loaded();
  review.point(false);
  clickMarker();

  const send = [...pop().querySelectorAll('.rprTurnState button')].find(b => b.textContent === 'send');
  expect(send).to.not.equal(undefined);
  send.click();
  expect(wire.sent.length).to.equal(1);
  expect(wire.sent[0].ask).to.equal('and drop the date');
});

it('resolving takes the comment off the page and shuts the popover', async () => {
  await threaded('test:ui-resolve');
  clickMarker();
  topBtn('resolve').click();

  expect(pop().hidden).to.equal(true);
  expect(marker()).to.equal(null);
  expect(barBtn('1 resolved')).to.not.equal(undefined);
});

it('the resolved list is the way back to one', async () => {
  await threaded('test:ui-resolved-list');
  clickMarker();
  topBtn('resolve').click();
  barBtn('1 resolved').click();

  expect(textOf(pop(), '.rprOrphan p')).to.deep.equal(['make this shorter']);
  [...pop().querySelectorAll('.rprOrphan button')].find(b => b.textContent === 'reopen').click();

  expect(marker()).to.not.equal(null);
  expect(pop().hidden).to.equal(false);
  expect(topBtn('resolve')).to.not.equal(undefined);
});

it('a resolved comment can be discarded from the list', async () => {
  await threaded('test:ui-resolved-discard');
  clickMarker();
  topBtn('resolve').click();
  barBtn('1 resolved').click();
  [...pop().querySelectorAll('.rprOrphan button')].find(b => b.textContent === 'discard').click();

  expect(review.json().items.filter(i => i.kind === 'comment').length).to.equal(0);
  expect(pop().hidden).to.equal(true);
});

it('the pill reports the turn and is a way back into the thread', async () => {
  const wire = await threaded('test:ui-pill');
  const req = wire.sent[0].id;
  wire.sink.state(req, 'acked');

  expect(pill().hidden).to.equal(false);
  expect(pill().querySelector('.rprWireText').textContent).to.equal('the agent is working');
  expect(pill().querySelector('.rprDot').classList.contains('working')).to.equal(true);

  pill().click();
  expect(pop().hidden).to.equal(false);
  expect(turns().length).to.equal(1);
});

it('a page with no transport builds no pill at all', async () => {
  review = mount({ key: 'test:ui-no-pill' });
  await loaded();
  madeComment('make this shorter');
  expect(pill()).to.equal(null);
});
