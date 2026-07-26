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
    let v = el.redpenContext;
    if (typeof v === 'function') {
      // a throwing provider costs the host its context, never the note itself
      try { v = v(info); } catch (err) { console.warn('[redpen] context provider threw', err); v = null; }
    }
    if (!v && el.hasAttribute(ATTR)) {
      try { v = JSON.parse(el.getAttribute(ATTR)); } catch { v = null; }
    }
    if (v && typeof v === 'object') out = { ...(out || {}), ...v };
  }
  return out;
}
