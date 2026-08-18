// mark.js — one place that says "this node is redpen's, not the page's".
//
// Every host that saves a page has to be told which nodes are chrome, and each
// of these tokens is honored by a different one, which is why none of them is
// redundant next to the others:
//
//   no-snapshot  keeps the node out of every serialization, and out of
//                hyper-morph's SYNC_IGNORE_SELECTOR, so a change arriving from
//                disk mid-review cannot delete the UI being typed into.
//   no-save      keeps it out of the saved file, which is the token every host
//                that persists a page reads, and the only one some of them do.
//   no-watch     keeps ink strokes out of the mutation system entirely, rather
//                than admitting every stroke and filtering it per consumer.
//
// sap-ignore says the same thing to sapjs. None of the spellings is free-form:
// clayjs matches [clay~="..."] against the token list in its region-policy.js.
//
// BOTH spellings go on every node, and that is not belt and braces. hyperclayjs,
// which is what hyperclay.com and hyperclay-local serve, parses no `clay`
// attribute at all: its region-policy has `[no-save], [save-remove]` and
// `[snapshot-remove], [no-snapshot]` and reads the rest with bare
// `hasAttribute`. A node marked only the clay way is saved into the file there,
// and its every DOM write reaches the mutation hub and triggers an autosave.
// clayjs accepts the bare forms as well, so the pair covers both hosts.
const CLAY = 'no-save no-snapshot no-watch';
const BARE = ['no-save', 'no-snapshot', 'no-watch'];

export function mark(node) {
  node.setAttribute('sap-ignore', '');
  node.setAttribute('clay', CLAY);
  for (const token of BARE) node.setAttribute(token, '');
  return node;
}

// Chrome the engine must never mistake for page content: topElementAt and
// elementsInArea both skip [data-la-ui] subtrees, so without this a click beside
// the popover files a note about the popover. A <style> takes mark() instead,
// since data-la-ui on a node that is never hit-tested asserts something false.
export function chrome(node) {
  node.dataset.laUi = '1';
  return mark(node);
}
