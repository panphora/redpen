import { expect } from '@esm-bundle/chai';
import { mount } from '../src/review.js';
import { attach, nearestKey, payloadFor } from '../src/wire.js';

// The two halves of putting a comment on the wire: the review adapter noticing
// that a comment is finished, and the transport turning it into a request a
// local process can act on.

const FIXTURE = `
<main>
  <section id="s1">
    <p style="height: 60px">Something the page says about itself.</p>
  </section>
  <div class="card" data-id="card-2">
    <svg class="art" viewBox="0 0 100 80" style="width: 200px; height: 160px">
      <rect width="100" height="80" fill="#eee"></rect>
    </svg>
  </div>
</main>`;

let review = null;
let attached = null;

function pop() {
  return document.querySelector('.rprPop');
}

function footBtn(label) {
  return [...pop().querySelectorAll('.rprFoot button')].find(b => b.textContent.startsWith(label));
}

// A real gesture, because there is no public way to add a note: point mode puts
// a capture overlay over the page, and a tap on it files an element note about
// whatever is underneath.
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

// A drag across registered artwork: the note that lands is a viewbox region,
// the shape whose geometry resolves through the target rather than through the
// element under the pointer.
function dragAcross(selector) {
  review.point(true);
  const overlay = document.getElementById('laOverlay');
  const r = document.querySelector(selector).getBoundingClientRect();
  const at = (x, y) => ({
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
    clientX: Math.round(x), clientY: Math.round(y),
  });
  overlay.dispatchEvent(new PointerEvent('pointerdown', at(r.left + 10, r.top + 10)));
  overlay.dispatchEvent(new PointerEvent('pointermove', at(r.left + 90, r.top + 70)));
  overlay.dispatchEvent(new PointerEvent('pointerup', at(r.left + 90, r.top + 70)));
}

// Typing, then clicking done: the case that used to emit nothing at all, since
// the click reaches flushAnswer with the text already written by the last input.
function say(words) {
  const field = pop().querySelector('textarea');
  field.value = words;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

function fakeWire() {
  const sent = [];
  const listeners = new Set();
  let n = 0;
  return {
    sent,
    listeners,
    send(payload, opts) {
      const id = 'r' + ++n;
      sent.push({ id, payload, opts });
      return { id, state: 'sent', done: Promise.resolve({ id, state: 'done' }), cancel: () => true };
    },
    cancel(id) { sent.push({ cancelled: id }); return true; },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(rec) { for (const fn of listeners) fn(rec); },
    get: () => undefined,
    list: () => [],
    isBusy: () => false,
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = FIXTURE;
});

afterEach(() => {
  attached?.detach();
  attached = null;
  review?.destroy();
  review = null;
  delete window.clay;
  document.body.innerHTML = '';
});

it('announces a finished comment once, with the projection its geometry needs', () => {
  review = mount({ key: 'test:signal' });
  const seen = [];
  review.onComment((item, projection) => seen.push({ item, projection }));

  tapComment();
  say('this paragraph should say more');
  footBtn('done').click();

  expect(seen.length).to.equal(1);
  expect(seen[0].item.kind).to.equal('comment');
  expect(seen[0].item.said).to.equal('this paragraph should say more');
  expect(seen[0].projection.items.some(i => i.id === seen[0].item.id)).to.equal(true);
});

it('says nothing about a comment with no words in it', () => {
  review = mount({ key: 'test:empty' });
  const seen = [];
  review.onComment(item => seen.push(item));

  tapComment();
  footBtn('done').click();

  expect(seen.length).to.equal(0);
});

it('says nothing about a discarded comment', () => {
  review = mount({ key: 'test:discard' });
  const seen = [];
  review.onComment(item => seen.push(item));

  tapComment();
  say('never mind');
  footBtn('discard').click();

  expect(seen.length).to.equal(0);
});

it('sends the region key the merge will place the answer by', () => {
  const wire = fakeWire();
  window.clay = { wire };
  review = mount({ key: 'test:payload' });
  attached = attach(review);

  tapComment();
  say('rewrite this paragraph');
  footBtn('done').click();

  expect(wire.sent.length).to.equal(1);
  const { payload, opts } = wire.sent[0];
  expect(payload.said).to.equal('rewrite this paragraph');
  expect(payload.item.kind).to.equal('comment');
  // The note is on <p>, whose nearest keyed ancestor is the section: a dirty root
  // with no key holds the whole incoming frame back.
  expect(payload.region.selector).to.equal('#s1');
  // coords is the legend for reading the item's numbers, and it is prose.
  expect(payload.coords).to.be.a('string');
  expect(opts.text).to.equal('rewrite this paragraph');
});

it('degrades to the clipboard when the page has no wire', () => {
  review = mount({ key: 'test:nowire' });
  expect(attach(review)).to.equal(null);

  tapComment();
  say('still just a note');
  expect(() => footBtn('done').click()).to.not.throw();
});

it('shows what the agent is doing, and cancels it', () => {
  const wire = fakeWire();
  window.clay = { wire };
  review = mount({ key: 'test:states' });
  attached = attach(review);

  tapComment();
  say('do the thing');
  footBtn('done').click();

  const pill = document.querySelector('.rprWire');
  expect(pill.hidden).to.equal(false);

  wire.emit({ id: 'r1', state: 'acked', text: 'reading the file', error: null });
  expect(pill.textContent).to.contain('reading the file');

  pill.querySelector('button').click();
  expect(wire.sent.some(s => s.cancelled === 'r1')).to.equal(true);

  wire.emit({ id: 'r1', state: 'error', text: '', error: 'no agent is attached to this file' });
  expect(pill.textContent).to.contain('no agent is attached');
});

it('walks to the nearest keyed ancestor, data-id first', () => {
  document.body.innerHTML = '<div id="outer"><div data-id="inner"><span id="leaf"></span><b></b></div></div>';
  expect(nearestKey(document.querySelector('b')).selector).to.equal('[data-id="inner"]');
  expect(nearestKey(document.getElementById('leaf')).selector).to.equal('#leaf');
  expect(nearestKey(document.createElement('i'))).to.equal(null);
});

it('carries a registered target basis instead of the page coords', () => {
  const item = { kind: 'comment', id: 'n1', said: 'here', target_id: 'chart', anchor: null };
  const projection = { page: 'index.htmlclay', coords: 'note boxes are fractions of the target element box', targets: { chart: { basis: { type: 'viewbox' } } }, items: [item] };
  const payload = payloadFor(item, projection);
  expect(payload.target).to.deep.equal({ basis: { type: 'viewbox' } });
  expect(payload.coords).to.equal(undefined);
});

// Every way out of an open comment announces it, not just the done button. Point
// mode stays on while the popover is open, so a second tap is an ordinary
// gesture, and before this the first comment was persisted and never sent, with
// no way back to its own done button.
it('announces a comment left open when the next one is started', () => {
  review = mount({ key: 'test:replaced' });
  const seen = [];
  review.onComment(item => seen.push(item));

  tapComment();
  say('the first thing');
  tapComment();

  expect(seen.length).to.equal(1);
  expect(seen[0].said).to.equal('the first thing');

  say('the second thing');
  footBtn('done').click();
  expect(seen.map(i => i.said)).to.deep.equal(['the first thing', 'the second thing']);
});

it('announces a comment left open when a question is opened', () => {
  document.querySelector('main p').setAttribute('data-review-ask', 'Is this right?');
  document.querySelector('main p').id = 'ask-p';
  review = mount({ key: 'test:to-question' });
  review.refresh();
  const seen = [];
  review.onComment(item => seen.push(item));

  tapComment();
  say('said before switching');
  review.open('ask-p');

  expect(seen.map(i => i.said)).to.deep.equal(['said before switching']);
});

it('says nothing about a comment that is only whitespace', () => {
  review = mount({ key: 'test:blank' });
  const seen = [];
  review.onComment(item => seen.push(item));

  tapComment();
  say('   \n  ');
  footBtn('done').click();

  expect(seen.length).to.equal(0);
});

// A drag inside registered artwork stores its geometry in the target's viewBox,
// and used to carry no element descriptor at all — so the agent got coordinates
// with nothing to place them by, which is the exact case scoped live-sync cannot
// merge.
it('gives a registered-target region the key of the card it sits in', () => {
  const wire = fakeWire();
  window.clay = { wire };
  review = mount({ key: 'test:viewbox' });
  review.pen.addTarget({ id: 'art', selector: '.art', basis: { type: 'viewbox', viewBox: [0, 0, 100, 80] } });
  attached = attach(review);

  dragAcross('.art');
  say('make this line thicker');
  footBtn('done').click();

  const { payload } = wire.sent[0];
  expect(payload.item.shape).to.equal('region');
  // The artwork itself carries no key, which is the ordinary shape: the card
  // around it does. Before the descriptor rode along, this region reached the
  // agent with coordinates and nothing to place them by.
  expect(payload.region.selector).to.equal('[data-id="card-2"]');
  expect(payload.target).to.be.an('object');
});

// One review, two listeners, and one transport. A page that passed its own
// callback to mount() keeps it when a transport attaches and after it detaches,
// and attaching twice is idempotent rather than a second pill nobody can remove.
it('keeps every comment listener separate', () => {
  const wire = fakeWire();
  window.clay = { wire };
  const fromMount = [];
  review = mount({ key: 'test:listeners', onComment: item => fromMount.push(item) });

  const first = attach(review);
  expect(attach(review)).to.equal(first);
  expect(document.querySelectorAll('.rprWire').length).to.equal(1);

  tapComment();
  say('while attached');
  footBtn('done').click();
  expect(fromMount.length).to.equal(1);
  expect(wire.sent.length).to.equal(1);

  first.detach();
  expect(document.querySelector('.rprWire')).to.equal(null);
  expect(document.getElementById('rprWireStyle')).to.equal(null);

  tapComment();
  say('after detaching');
  footBtn('done').click();
  // The page's own listener is untouched; only the transport went away.
  expect(fromMount.length).to.equal(2);
  expect(wire.sent.length).to.equal(1);
});
