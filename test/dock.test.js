import { expect } from '@esm-bundle/chai';
import { mount } from '../src/mount.js';
import '../src/index-review.js';

// The dock: one bar, one strip, one panel, one popover. These are the rules a
// reviewer feels rather than reads — what ends a mode, what sends, what Escape
// puts back — plus the pieces of the engine the dock leans on.

const FIXTURE = `
<main>
  <h2 id="how-it-works">How it works</h2>
  <p id="p1" style="height: 60px">Something the page says about itself.</p>
  <p id="p2" style="height: 60px">Something else it says.</p>
  <button id="hostBtn" type="button">a host control</button>
</main>`;

let review = null;

const pop = () => document.querySelector('.rprPop');
const dock = () => document.querySelector('.rpDock');
const q = sel => document.querySelector(sel);
const all = sel => [...document.querySelectorAll(sel)];

const field = () => pop().querySelector('textarea');

const footBtn = label =>
  [...pop().querySelectorAll('.rprFoot button')].find(b => b.textContent.startsWith(label));

function pointAt(node) {
  const r = node.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function tapComment(sel = '#p1', { shift = false } = {}) {
  review.point(true);
  const overlay = document.getElementById('laOverlay');
  const { x, y } = pointAt(document.querySelector(sel));
  const at = {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
    clientX: x, clientY: y, shiftKey: shift,
  };
  overlay.dispatchEvent(new PointerEvent('pointerdown', at));
  overlay.dispatchEvent(new PointerEvent('pointerup', at));
}

function say(words) {
  const f = field();
  f.value = words;
  f.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(name, opts = {}, target = window) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...opts }));
}

function pressOn(node) {
  node.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, pointerId: 2, isPrimary: true, button: 0,
  }));
}

function madeComment(words, sel = '#p1') {
  tapComment(sel);
  say(words);
  footBtn('comment').click();
}

const markers = () => all('.laMarkers [data-la-note]');
const marker = () => markers()[0] || null;
const tagOf = el => (el && (el.querySelector('.tag') || el)) || null;

const clickMarker = (el = marker()) => {
  tagOf(el).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
};

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

const loaded = () => new Promise(resolve => {
  if (review.pen.loaded()) return resolve();
  review.pen.addEventListener('change', function once(e) {
    if (!e.detail || e.detail.action !== 'load') return;
    review.pen.removeEventListener('change', once);
    resolve();
  });
});

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const items = () => review.pen.items();
const listBtn = () => q('.rpList');
const moreBtn = () => q('.rpMore');
const sendBtn = () => q('.rpSend');
const menuItem = label => [...document.querySelectorAll('.rpMenu .mi')].find(b => b.textContent.startsWith(label));
const rows = () => all('.rpPanel .rpRow');

// A stroke made the way a hand makes one: the draw canvas takes the gesture and
// finishStroke converts it into the target's basis.
function drawOn(node) {
  review.mode('draw');
  const r = node.getBoundingClientRect();
  const canvas = document.querySelector('canvas[data-la-ui]');
  const at = (dx, dy) => ({
    bubbles: true, cancelable: true, pointerId: 3, isPrimary: true, button: 0,
    clientX: Math.round(r.left + dx), clientY: Math.round(r.top + dy),
  });
  canvas.dispatchEvent(new PointerEvent('pointerdown', at(20, 20)));
  canvas.dispatchEvent(new PointerEvent('pointermove', at(60, 40)));
  canvas.dispatchEvent(new PointerEvent('pointermove', at(100, 80)));
  canvas.dispatchEvent(new PointerEvent('pointerup', at(100, 80)));
  review.mode(null);
}

function addArt() {
  document.body.insertAdjacentHTML('beforeend',
    '<svg id="art" viewBox="0 0 200 200" style="width:200px;height:200px"><rect width="200" height="200" fill="#eee"></rect></svg>');
  const art = document.getElementById('art');
  review.pen.addTarget({ id: 'art', selector: '#art', basis: { type: 'viewbox', viewBox: [0, 0, 200, 200] } });
  return art;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = FIXTURE;
  document.body.style.background = '';
});

afterEach(() => {
  review?.destroy();
  review = null;
  document.body.innerHTML = '';
  document.body.style.background = '';
});

// ---------- placing ----------

it('placing a comment ends comment mode', async () => {
  review = mount({ key: 'dock:place', wire: false });
  await loaded();
  tapComment();

  expect(review.pen.mode()).to.equal(null);
  expect(getComputedStyle(document.getElementById('laOverlay')).display).to.equal('none');
  expect(pop().hidden).to.equal(false);
  expect(document.activeElement).to.equal(field());
});

it('shift-click keeps comment mode on', async () => {
  review = mount({ key: 'dock:sticky', wire: false });
  await loaded();
  tapComment('#p1', { shift: true });

  expect(review.pen.mode()).to.equal('note');
  expect(pop().hidden).to.equal(false);
});

// ---------- the ways out ----------

it('done sends once, and reopening does not send again', async () => {
  review = mount({ key: 'dock:done-once', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  madeComment('make this shorter');
  expect(wire.sent.length).to.equal(1);

  clickMarker();
  q('.rpRight').click();
  expect(wire.sent.length).to.equal(1);
});

it('clicking away keeps a draft, the page still gets the click, and Send ships it', async () => {
  review = mount({ key: 'dock:away', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  let sawIt = false;
  const p = document.getElementById('p2');
  p.addEventListener('pointerdown', () => { sawIt = true; });

  tapComment();
  say('this reads oddly');
  pressOn(p);

  expect(pop().hidden).to.equal(true);
  expect(wire.sent.length).to.equal(0);
  expect(sawIt).to.equal(true);

  sendBtn().click();
  expect(wire.sent.length).to.equal(1);
});

it('a click on a control keeps the box open', async () => {
  review = mount({ key: 'dock:control', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  tapComment();
  say('this reads oddly');
  pressOn(document.getElementById('hostBtn'));

  expect(pop().hidden).to.equal(false);
  expect(wire.sent.length).to.equal(0);
});

it('Escape on a brand-new comment discards it, and the toast puts it back', async () => {
  review = mount({ key: 'dock:esc-new', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  tapComment();
  say('never mind');
  key('Escape');

  expect(items().length).to.equal(0);
  expect(wire.sent.length).to.equal(0);
  const toast = q('.rpToast');
  expect(toast).to.not.equal(null);

  [...toast.querySelectorAll('button')].find(b => b.textContent === 'undo').click();
  expect(items().length).to.equal(1);
  expect(items()[0].text).to.equal('never mind');
  expect(marker()).to.not.equal(null);
});

it('Escape on a reopened comment reverts what this visit changed', async () => {
  review = mount({ key: 'dock:esc-reopen', wire: false });
  await loaded();
  const seen = [];
  review.onComment(item => seen.push(item));

  madeComment('first thought');
  expect(seen.length).to.equal(1);

  clickMarker();
  say('second thought');
  key('Escape');

  expect(items()[0].text).to.equal('first thought');
  expect(seen.length).to.equal(1);
});

it('Escape on a thread drops the unsent follow-up', async () => {
  review = mount({ key: 'dock:esc-draft', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  wire.sink.state(wire.sent[0].id, 'done');

  clickMarker();
  say('half a thought');
  key('Escape');

  expect(items()[0].draft).to.equal(undefined);
  expect(wire.sent.length).to.equal(1);
});

it('a blank comment is removed on done', async () => {
  review = mount({ key: 'dock:blank', wire: false });
  await loaded();
  tapComment();
  footBtn('comment').click();

  expect(items().length).to.equal(0);
});

// ---------- the keyboard ----------

it('C and D toggle a mode, and are ignored while typing', async () => {
  review = mount({ key: 'dock:keys', wire: false });
  await loaded();

  key('c');
  expect(review.pen.mode()).to.equal('note');
  key('c');
  expect(review.pen.mode()).to.equal(null);

  key('d');
  expect(review.pen.mode()).to.equal('draw');
  key('d');
  expect(review.pen.mode()).to.equal(null);

  tapComment();
  key('d', {}, field());
  expect(review.pen.mode()).to.equal(null);
});

it('cmd-enter finishes the comment', async () => {
  review = mount({ key: 'dock:cmd-enter', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  tapComment();
  say('make this shorter');
  key('Enter', { metaKey: true }, field());

  expect(pop().hidden).to.equal(true);
  expect(wire.sent.length).to.equal(1);
});

it('Escape backs out one step at a time', async () => {
  review = mount({ key: 'dock:esc-order', wire: false });
  await loaded();

  key('c');
  moreBtn().click();
  expect(q('.rpPanel').hidden).to.equal(false);

  key('Escape');
  expect(q('.rpPanel').hidden).to.equal(true);
  expect(review.pen.mode()).to.equal('note');

  key('Escape');
  expect(review.pen.mode()).to.equal(null);
});

it('N is unbound until the page asks something', async () => {
  review = mount({ key: 'dock:n-key', wire: false });
  await loaded();

  key('n');
  expect(pop().hidden).to.equal(true);

  document.getElementById('p2').setAttribute('data-review-ask', 'Is this clear?');
  review.refresh();
  key('n');

  expect(pop().hidden).to.equal(false);
  expect(pop().querySelector('.rprQ').textContent).to.equal('Is this clear?');
});

// ---------- the theme ----------

it('the theme follows the page', async () => {
  review = mount({ key: 'dock:theme', wire: false });
  await loaded();

  document.body.style.background = '#11151B';
  await tick();
  expect(dock().dataset.rpTheme).to.equal('dark');

  document.body.style.background = '#FDFDFC';
  await tick();
  expect(dock().dataset.rpTheme).to.equal('light');
});

it('the theme probe reads colours the page did not write in sRGB', async () => {
  review = mount({ key: 'dock:theme-oklch', wire: false });
  await loaded();

  document.body.style.background = 'oklch(0.18 0.02 260)';
  await tick();
  expect(dock().dataset.rpTheme).to.equal('dark');

  document.body.style.background = 'oklch(0.98 0.005 90)';
  await tick();
  expect(dock().dataset.rpTheme).to.equal('light');
});

// ---------- the ink ----------

it('every stroke is drawn twice, the halo under the ink', async () => {
  review = mount({ key: 'dock:halo', wire: false });
  await loaded();
  const art = addArt();
  drawOn(art);

  const paths = [...document.querySelectorAll('.laMarks path')];
  expect(paths.length).to.equal(2);
  expect(Number(paths[0].getAttribute('stroke-width')))
    .to.be.greaterThan(Number(paths[1].getAttribute('stroke-width')));
});

// ---------- holding comments back ----------

it('hold mode keeps a finished comment for the Send button', async () => {
  localStorage.setItem('redpen:hold:dock:hold', '1');
  review = mount({ key: 'dock:hold', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  madeComment('make this shorter');
  expect(wire.sent.length).to.equal(0);
  expect(sendBtn().textContent).to.equal('Send 1');

  sendBtn().click();
  expect(wire.sent.length).to.equal(1);
  expect(sendBtn().textContent).to.equal('Send');
  expect(sendBtn().disabled).to.equal(true);
});

it('Send ships the pending comments, one on the wire at a time', async () => {
  localStorage.setItem('redpen:hold:dock:send-order', '1');
  review = mount({ key: 'dock:send-order', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  madeComment('the first thing', '#p1');
  madeComment('the second thing', '#p2');
  expect(wire.sent.length).to.equal(0);

  expect(review.send()).to.equal(2);
  expect(wire.sent.length).to.equal(1);
  const second = items()[1];
  expect(second.thread[0].state).to.equal('queued');

  wire.sink.state(wire.sent[0].id, 'done');
  expect(wire.sent.length).to.equal(2);
  expect(wire.sent[1].ask).to.equal('the second thing');
});

it('an unsent follow-up draft counts as pending', async () => {
  review = mount({ key: 'dock:draft-pending', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  wire.sink.state(wire.sent[0].id, 'done');

  clickMarker();
  say('two sentences, not three');
  pressOn(document.getElementById('p2'));

  expect(sendBtn().textContent).to.equal('Send 1');
  sendBtn().click();

  expect(wire.sent.length).to.equal(2);
  expect(wire.sent[1].turn).to.equal(2);
});

it('Send closes the open box first, and reopening it is a follow-up', async () => {
  localStorage.setItem('redpen:hold:dock:send-open', '1');
  review = mount({ key: 'dock:send-open', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  tapComment();
  say('the original comment');
  sendBtn().click();

  expect(pop().hidden).to.equal(true);
  expect(wire.sent.length).to.equal(1);
  expect(items()[0].text).to.equal('the original comment');
  wire.sink.state(wire.sent[0].id, 'done');

  clickMarker();
  expect(footBtn('send')).to.not.equal(undefined);
  say('and now a follow-up');
  footBtn('send').click();

  expect(items()[0].text).to.equal('the original comment');
  expect(wire.sent.length).to.equal(2);
  expect(wire.sent[1].turn).to.equal(2);
});

it('a resolved comment is not pending', async () => {
  localStorage.setItem('redpen:hold:dock:resolved-pending', '1');
  review = mount({ key: 'dock:resolved-pending', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);

  madeComment('the first thing', '#p1');
  madeComment('the second thing', '#p2');
  review.thread.resolve(items()[1].id, true);

  expect(sendBtn().textContent).to.equal('Send 1');
  expect(review.send()).to.equal(1);
  expect(wire.sent.length).to.equal(1);
  expect(wire.sent[0].ask).to.equal('the first thing');
  expect(!!items()[1].resolved).to.equal(true);
});

it('a refused send counts nothing and says so', async () => {
  localStorage.setItem('redpen:hold:dock:refused', '1');
  review = mount({ key: 'dock:refused', wire: false });
  await loaded();
  const wire = fakeTransport({ refuse: true });
  review.thread.connect(wire);

  madeComment('make this shorter');
  expect(sendBtn().textContent).to.equal('Send 1');
  sendBtn().click();

  expect(wire.sent.length).to.equal(1);
  expect(items()[0].thread[0].state).to.equal('error');
  expect(sendBtn().textContent).to.equal('not sent, copy instead');
});

// ---------- the panel ----------

it('clearing everything asks first, in place', async () => {
  review = mount({ key: 'dock:clear', wire: false });
  await loaded();
  madeComment('make this shorter');

  moreBtn().click();
  menuItem('Clear all comments').click();
  expect(items().length).to.equal(1);

  const row = q('.rpConfirm');
  expect(row).to.not.equal(null);
  [...row.querySelectorAll('button')].find(b => b.textContent === 'delete').click();
  expect(items().length).to.equal(0);
});

it('a row delete leaves an undo behind', async () => {
  review = mount({ key: 'dock:row-delete', wire: false });
  await loaded();
  madeComment('the first thing', '#p1');
  madeComment('the second thing', '#p2');
  const before = items().map(n => n.id);

  listBtn().click();
  expect(rows().length).to.equal(2);
  // the older of the two, so putting it back has to land it in front again
  rows()[1].querySelector('.sub.danger').click();
  expect(items().length).to.equal(1);

  const toast = q('.rpToast');
  expect(toast).to.not.equal(null);
  [...toast.querySelectorAll('button')].find(b => b.textContent === 'undo').click();

  expect(items().map(n => n.id)).to.deep.equal(before);
});

it('a list row highlights the marker it belongs to', async () => {
  review = mount({ key: 'dock:highlight', wire: false });
  await loaded();
  madeComment('make this shorter');
  listBtn().click();

  const row = rows()[0];
  row.dispatchEvent(new MouseEvent('mouseenter'));
  expect(marker().classList.contains('hot')).to.equal(true);

  row.dispatchEvent(new MouseEvent('mouseleave'));
  expect(marker().classList.contains('hot')).to.equal(false);
});

it('hovering a marker shows the comment', async () => {
  review = mount({ key: 'dock:peek', wire: false });
  await loaded();
  madeComment('make this shorter');

  tagOf(marker()).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const tip = q('.rprTip');
  expect(tip.hidden).to.equal(false);
  expect(tip.textContent).to.equal('make this shorter');

  tagOf(marker()).dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  expect(tip.hidden).to.equal(true);
});

it('the marker pulses while its request runs', async () => {
  review = mount({ key: 'dock:working', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');

  expect(tagOf(marker()).classList.contains('working')).to.equal(true);
  wire.sink.state(wire.sent[0].id, 'done');
  expect(tagOf(marker()).classList.contains('working')).to.equal(false);
});

it('deleting the open comment from the list closes its box', async () => {
  review = mount({ key: 'dock:delete-open', wire: false });
  await loaded();
  madeComment('make this shorter');
  clickMarker();
  expect(pop().hidden).to.equal(false);

  listBtn().click();
  rows()[0].querySelector('.sub.danger').click();

  expect(items().length).to.equal(0);
  expect(pop().hidden).to.equal(true);
});

it('a follow-up draft shows as unsent in the list', async () => {
  review = mount({ key: 'dock:draft-label', wire: false });
  await loaded();
  const wire = fakeTransport();
  review.thread.connect(wire);
  madeComment('make this shorter');
  wire.sink.state(wire.sent[0].id, 'done');

  clickMarker();
  say('two sentences, not three');
  pressOn(document.getElementById('p2'));

  listBtn().click();
  expect(rows()[0].querySelector('.mini').textContent).to.equal('unsent');
});

// ---------- the markers ----------

it('markers carry their number', async () => {
  review = mount({ key: 'dock:numbers', wire: false });
  await loaded();
  madeComment('make this shorter');

  expect(q('.laMarkers .tag').textContent).to.equal('1');
});

// ---------- copy ----------

it('copies everything, the comments alone, or the drawing alone', async () => {
  review = mount({ key: 'dock:copy', wire: false });
  await loaded();
  const art = addArt();
  madeComment('make this shorter');
  drawOn(art);

  const everything = review.json();
  expect(everything.items.length).to.be.greaterThan(0);
  expect(everything.strokes.length).to.equal(1);

  const comments = JSON.parse(review.copy('comments'));
  expect(comments.strokes).to.equal(undefined);
  expect(comments.items.length).to.be.greaterThan(0);

  const drawing = JSON.parse(review.copy('drawing'));
  expect(drawing.items).to.equal(undefined);
  expect(drawing.strokes.length).to.equal(1);
});

// ---------- the mount options ----------

it('a missing tool has no icon and no key', async () => {
  review = mount({ key: 'dock:tools', wire: false, tools: ['comment'] });
  await loaded();

  expect(q('.rpDraw')).to.equal(null);
  key('d');
  expect(review.pen.mode()).to.equal(null);
});

it('keys: false binds nothing', async () => {
  review = mount({ key: 'dock:no-keys', wire: false, keys: false });
  await loaded();

  key('c');
  expect(review.pen.mode()).to.equal(null);
});

it('destroy takes every piece of chrome with it', async () => {
  review = mount({ key: 'dock:destroy', wire: false });
  await loaded();
  madeComment('make this shorter');
  listBtn().click();
  rows()[0].querySelector('.sub.danger').click();
  expect(q('.rpToast')).to.not.equal(null);

  review.destroy();
  review = null;

  expect(q('.rpDock')).to.equal(null);
  expect(q('.rprPop')).to.equal(null);
  expect(q('.rprTip')).to.equal(null);
  expect(q('.rpToast')).to.equal(null);

  review = mount({ key: 'dock:destroy', wire: false });
  await loaded();
  expect(q('.rpDock')).to.not.equal(null);
});

// Last, because the standalone shim keeps its instance for the life of the page.
it('the old entry points still answer', async () => {
  delete window.RedpenReview;
  await import('../src/index.js');

  expect(window.RedpenReview.mount).to.be.a('function');
  expect(window.Redpen.mount).to.be.a('function');
  expect(window.RedpenWire.attach).to.be.a('function');

  const hub = window.FeedbackHub;
  expect(hub.tools.some(t => t.getOn())).to.equal(false);
  hub.tools[0].setOn(true);
  expect(hub.tools.some(t => t.getOn())).to.equal(true);
  hub.tools[0].setOn(false);
  expect(hub.tools.some(t => t.getOn())).to.equal(false);

  const first = window.Redpen.mount();
  expect(window.RedpenReview.mount({ key: 'ignored' })).to.equal(first);
  expect(all('.rpDock').length).to.equal(1);
});
