// context.js — the discovery walk that lets a page enrich its own notes.
//
// redpen discovers context; the page exposes it. When a note is created the walk
// runs from the annotated element up to <html>, asking each ancestor for a
// contribution, and merges what comes back onto the note. redpen stores and
// exports that payload verbatim and interprets none of it, so nothing about any
// particular host page leaks in here.
//
// Two ways to contribute, both found by the same walk:
//
//   el.redpenContext = info => ({ myApp: { ... } })        // dynamic, per note
//   <div data-redpen-context='{"myApp":{"build":"a41"}}'>  // static, no script
//
// `info` is the gesture that made the note: { kind, x, y, box, targetId }, with
// x/y and box in client px, so a provider can ask its own scene what sits under
// that exact point. A provider namespaces its payload under a key it owns: the
// merge is one level deep, outermost first, so an inner provider replaces an
// outer one's namespace wholesale rather than half of it.

const ATTR = 'data-redpen-context';

export function collectContext(startEl, info) {
  const chain = [];
  for (let el = startEl; el && el.nodeType === 1; el = el.parentElement) chain.push(el);
  let out = null;
  for (const el of chain.reverse()) {
    // Every step is guarded, not just the call. A throwing getter, an exotic
    // property, or a spread trap costs the host its contribution and nothing
    // else: a note is never lost because a page misbehaved.
    try {
      let v = el.redpenContext;
      if (typeof v === 'function') v = v(info);
      if (!v && el.hasAttribute(ATTR)) {
        try { v = JSON.parse(el.getAttribute(ATTR)); } catch { v = null; }
      }
      if (v && typeof v === 'object') out = { ...(out || {}), ...v };
    } catch (err) {
      console.warn('[redpen] context provider failed', el, err);
    }
  }
  if (out === null) return null;
  // The note is persisted with a bare JSON.stringify, so anything that cannot
  // survive that — a cycle, a DOM node, a BigInt — has to die HERE. Letting one
  // through makes every future save throw with the bad note already in the
  // array, which loses the notes silently and forever.
  try {
    return JSON.parse(JSON.stringify(out));
  } catch (err) {
    console.warn('[redpen] context dropped: not JSON-serializable', err);
    return null;
  }
}
