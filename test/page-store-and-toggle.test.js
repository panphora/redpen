import { expect } from '@esm-bundle/chai';
import { mount } from '../src/mount.js';

// The in-page store and the hidden mode: a page that carries its own review in
// <script type="application/json" id="redpen-data">, and a redpen that stays
// out of the way until the toggle sequence is typed.

const FIXTURE = `
<main>
  <p id="p1" style="height: 60px">Something the page says about itself.</p>
  <textarea id="host-field"></textarea>
</main>
<script type="application/json" id="redpen-data">{}</script>`;

let review = null;
let saves = 0;

const pop = () => document.querySelector('.rprPop');
const dock = () => document.querySelector('.rpDock');

const field = () => pop().querySelector('textarea');

const footBtn = label =>
  [...pop().querySelectorAll('.rprFoot button')].find(b => b.textContent.startsWith(label));

function pointAt(node) {
  const r = node.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

function tapComment(sel = '#p1') {
  review.point(true);
  const overlay = document.getElementById('laOverlay');
  const { x, y } = pointAt(document.querySelector(sel));
  const at = {
    bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
    clientX: x, clientY: y,
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

function madeComment(words, sel = '#p1') {
  tapComment(sel);
  say(words);
  footBtn('done').click();
}

const loaded = () => new Promise(resolve => {
  if (review.pen.loaded()) return resolve();
  review.pen.addEventListener('change', function once(e) {
    if (!e.detail || e.detail.action !== 'load') return;
    review.pen.removeEventListener('change', once);
    resolve();
  });
});

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const block = () => document.getElementById('redpen-data');
const blob = () => JSON.parse(block().textContent);
const notes = b => Object.values(b.targets || {}).flatMap(t => t.notes || []);

beforeEach(() => {
  localStorage.clear();
  saves = 0;
  window.clay = { save: () => { saves++; return Promise.resolve(); } };
  document.body.innerHTML = FIXTURE;
});

afterEach(() => {
  review?.destroy();
  review = null;
  delete window.clay;
  document.body.innerHTML = '';
});

it('writes comments into the page block and saves', async () => {
  review = mount({ key: 'page-store:write', wire: false });
  await loaded();
  madeComment('move this up');
  await tick(50);

  const saved = blob();
  expect(saved.v).to.equal(3);
  expect(notes(saved).some(n => n.text === 'move this up')).to.equal(true);
  expect(saves).to.be.greaterThan(0);
});

it('reads them back on the next mount', async () => {
  review = mount({ key: 'page-store:read', wire: false });
  await loaded();
  madeComment('move this up');
  await tick(50);

  review.destroy();
  review = mount({ key: 'page-store:read', wire: false });
  await loaded();

  expect(review.pen.items().length).to.equal(1);
});

it('escapes a closing script tag', async () => {
  review = mount({ key: 'page-store:escape', wire: false });
  await loaded();
  madeComment('see </script> here');
  await tick(50);

  const raw = block().textContent;
  expect(raw).to.not.contain('</script>');
  expect(raw).to.contain('\\u003c/script>');
  expect(notes(blob()).some(n => n.text === 'see </script> here')).to.equal(true);
});

it('hidden blocks every shortcut but the toggle', async () => {
  review = mount({ key: 'page-store:hidden', wire: false, hidden: true });
  await loaded();

  expect(getComputedStyle(dock()).display).to.equal('none');
  key('c');
  expect(review.pen.mode()).to.equal(null);

  key(';');
  key(';');
  expect(review.visible).to.equal(true);
  expect(getComputedStyle(dock()).display).to.not.equal('none');
  expect(review.pen.mode()).to.equal('note');
});

it('the toggle ignores typing in a field', async () => {
  review = mount({ key: 'page-store:field', wire: false, hidden: true });
  await loaded();

  const host = document.getElementById('host-field');
  host.focus();
  key(';', {}, host);
  key(';', {}, host);

  expect(review.visible).to.equal(false);
});

it('hiding mid-comment keeps exactly one note', async () => {
  review = mount({ key: 'page-store:half', wire: false });
  await loaded();
  tapComment('#p1');
  say('half written');

  review.hide();

  expect(review.pen.items().length).to.equal(1);
  const p = pop();
  expect(p.hidden || getComputedStyle(p).display === 'none').to.equal(true);
});

it('no block means no page store', async () => {
  block().remove();
  review = mount({ key: 'page-store:none', wire: false });
  await loaded();
  madeComment('move this up');
  await tick(50);

  expect(saves).to.equal(0);
});
