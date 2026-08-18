import { expect } from '@esm-bundle/chai';
import { mount } from '../src/review.js';
import { attach } from '../src/wire.js';
import { register, attachNotesPanel } from '../src/ui.js';
import { SNAPSHOT_REMOVE_SELECTOR, STRIP_FROM_SAVE } from '../../clayjs/src/lib/region-policy.js';
import {
  SNAPSHOT_REMOVE_SELECTOR as HC_SNAPSHOT_REMOVE,
  STRIP_FROM_SAVE as HC_STRIP_FROM_SAVE,
} from '../../hyperclayjs/src/utilities/region-policy.js';

// What a review session must never do: change the file.
//
// redpen mounts onto pages that save themselves. Anything it injects without
// marking, and any attribute it writes onto a node the page authored, reaches
// disk on the next autosave — and worse, makes that node a dirty root, which
// scoped live-sync then protects from the agent's own edit. A review page whose
// agent silently cannot change anything is the failure this file pins.
//
// The projection is clayjs's, not a local copy: a list written here would be
// written by whoever wrote redpen's marking, agree with it for the same wrong
// reason, and stay green while the file was being corrupted.

const FIXTURE = `
<main>
  <section id="s1">
    <p>Something the page says about itself.</p>
    <span id="ask-one" data-review-ask="Keep this line?">a line</span>
    <span id="ask-two" data-review-ask="And this one?" data-tooltip="the page's own">another line</span>
  </section>
</main>`;

// Both hosts, because they do not read the same attribute. clayjs understands
// `clay="no-save …"` and the bare forms; hyperclayjs, which is what
// hyperclay.com and hyperclay-local serve, parses no `clay` attribute at all.
// Marking for one and not the other saves every redpen node into the file on
// the other, and a projection built from one host's selectors cannot see it.
function saveDomain(selectors = `${SNAPSHOT_REMOVE_SELECTOR}, ${STRIP_FROM_SAVE}`) {
  const clone = document.documentElement.cloneNode(true);
  for (const node of clone.querySelectorAll(selectors)) node.remove();
  // The test runner's own bootstrap lives in <head> and is not part of any page
  // under review. It is constant, so leaving it in would not change a single
  // verdict, but it is ~8 KB per snapshot and it turns a one-attribute failure
  // into an unreadable wall. redpen injects no scripts, so nothing of its own
  // leaves with them.
  for (const node of clone.querySelectorAll('head script, head link')) node.remove();
  return clone.outerHTML;
}

let review = null;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = FIXTURE;
});

afterEach(() => {
  review?.destroy();
  review = null;
  document.body.innerHTML = '';
});

it('leaves the save domain identical through a whole review session', () => {
  const before = saveDomain();

  review = mount({ key: 'test:save-domain' });
  const mounted = saveDomain();

  // Point mode plus an open popover is the fullest the chrome ever gets. The
  // comment popover is the same `pop` node as this one, dressed differently, and
  // every difference between them is inside chrome the projection strips.
  review.point(true);
  review.open('ask-one');
  const working = saveDomain();

  review.point(false);
  review.destroy();
  review = null;
  const after = saveDomain();

  expect(mounted).to.equal(before);
  expect(working).to.equal(before);
  expect(after).to.equal(before);
});

// Without this, the test above passes just as well when mount() throws early and
// injects nothing at all.
it('is invisible to hyperclayjs as well, which reads only the bare attributes', () => {
  const hyperclay = `${HC_SNAPSHOT_REMOVE}, ${HC_STRIP_FROM_SAVE}`;
  const before = saveDomain(hyperclay);

  review = mount({ key: 'test:hyperclayjs', clickThrough: 'main p' });
  review.point(true);
  review.open('ask-one');

  expect(saveDomain(hyperclay)).to.equal(before);
});

it('really did inject marked chrome', () => {
  review = mount({ key: 'test:injected' });
  const marked = document.querySelectorAll('[clay~="no-snapshot"]');
  expect(marked.length).to.be.greaterThan(3);
  for (const node of marked) {
    expect(node.getAttribute('clay')).to.equal('no-save no-snapshot no-watch');
    expect(node.hasAttribute('sap-ignore')).to.equal(true);
    // The bare spelling is not decoration: it is the only one hyperclayjs reads.
    for (const token of ['no-save', 'no-snapshot', 'no-watch']) {
      expect(node.hasAttribute(token)).to.equal(true);
    }
  }
  // The head styles are the ones that carried nothing at all, and destroy()
  // leaves them behind, so their marking is the only thing keeping them out of
  // the file.
  for (const id of ['rprStyle', 'laSurfaceStyle']) {
    expect(document.getElementById(id).getAttribute('clay')).to.equal('no-save no-snapshot no-watch');
  }
});

// The projection has to have teeth, or every assertion above is vacuous. These
// are the two shapes the old code actually produced: an unmarked node of
// redpen's own, and an attribute written onto a node the page authored.
it('notices exactly what the old code did', () => {
  const before = saveDomain();

  const stray = document.createElement('div');
  document.body.appendChild(stray);
  expect(saveDomain()).to.not.equal(before);
  stray.remove();

  document.getElementById('ask-one').dataset.tooltip = 'Keep this line?';
  expect(saveDomain()).to.not.equal(before);
  document.getElementById('ask-one').removeAttribute('data-tooltip');

  document.body.classList.add('rprPointing');
  expect(saveDomain()).to.not.equal(before);
  // removeAttribute, not classList.remove: that leaves class="" behind, which is
  // itself a difference — and a fair illustration of why a class on the authored
  // <body> is the wrong lever.
  document.body.removeAttribute('class');

  expect(saveDomain()).to.equal(before);
});

it('previews a question without writing anything onto it', () => {
  review = mount({ key: 'test:preview' });
  const asked = document.getElementById('ask-one');

  asked.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const tip = document.querySelector('.rprTip');
  expect(tip.hidden).to.equal(false);
  expect(tip.textContent).to.equal('Keep this line?');
  expect(asked.hasAttribute('data-tooltip')).to.equal(false);

  // A page that brought its own tooltip keeps it, and gets no second bubble.
  document.getElementById('ask-two').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  expect(tip.hidden).to.equal(true);

  document.querySelector('main p').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  expect(tip.hidden).to.equal(true);
});

it('reads point mode off its own bar, not off the authored body', () => {
  review = mount({ key: 'test:pointing' });
  const bodyBefore = document.body.attributes.length;

  review.point(true);
  expect(document.querySelector('.rprBar').hasAttribute('data-pointing')).to.equal(true);
  expect(document.body.className).to.equal('');
  expect(document.body.attributes.length).to.equal(bodyBefore);

  review.point(false);
  expect(document.querySelector('.rprBar').hasAttribute('data-pointing')).to.equal(false);
});

// Everything above mounts the review adapter alone and without click-through.
// These are the injection paths that leaves untouched: the generated
// click-through rule, the standalone UI adapter's bar and notes panel, and the
// wire transport's pill and stylesheet.
it('keeps the save domain identical with every adapter mounted', () => {
  const before = saveDomain();

  window.clay = { wire: { send: () => ({ id: 'x', state: 'sent', done: Promise.resolve({}), cancel() {} }), cancel() {}, on: () => () => {} } };
  review = mount({ key: 'test:everything', clickThrough: 'main p' });
  const wire = attach(review);
  register({ id: 'notes', label: 'notes', labelOn: 'notes on', getOn: () => false, setOn() {}, clear() {}, getData: () => ({}) });
  attachNotesPanel(review.pen);
  review.point(true);

  expect(document.getElementById('rprClickThrough')).to.not.equal(null);
  expect(document.getElementById('laPanelStyle')).to.not.equal(null);
  expect(document.querySelector('.rprWire')).to.not.equal(null);
  expect(saveDomain()).to.equal(before);

  wire.detach();
  delete window.clay;
});

// destroy() used to remove whatever held the id rprClickThrough, so a page that
// happened to author that id lost the node — and a deletion is a local change
// scoped live-sync splices into the next disk frame, which would erase the
// agent's version of it.
it('destroys only the click-through rule it created', () => {
  const authored = document.createElement('div');
  authored.id = 'rprClickThrough';
  authored.textContent = 'the page authored this';
  document.querySelector('main').appendChild(authored);
  const before = saveDomain();

  review = mount({ key: 'test:collision', clickThrough: 'main p' });
  review.destroy();
  review = null;

  expect(document.getElementById('rprClickThrough')).to.equal(authored);
  expect(saveDomain()).to.equal(before);
});

it('destroys nothing of the page when it made no rule at all', () => {
  const authored = document.createElement('div');
  authored.id = 'rprClickThrough';
  document.querySelector('main').appendChild(authored);
  const before = saveDomain();

  review = mount({ key: 'test:no-rule' });
  review.destroy();
  review = null;

  expect(document.getElementById('rprClickThrough')).to.equal(authored);
  expect(saveDomain()).to.equal(before);
});
