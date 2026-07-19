// targets.js — the target registry and the two coordinate bases.
//
// A target is a first-class registered thing: {id, selector|el, basis}. A panel
// is a target; any marked element can be a target. Feedback is keyed by target
// id, and every note box and stroke point is stored in its target's basis.
//
//   {type:'viewbox', viewBox:[0,0,1000,820]}  store in the SVG's own user units,
//     the same coordinates the artwork is authored in. Screen <-> basis goes
//     through getScreenCTM(), so it is exact under any preserveAspectRatio,
//     DPR-proof, and survives letterboxing.
//   {type:'fraction'}  store fractions 0-1 of the element's box. This is the
//     region-note model redpen already had; the default page target uses it.

const PAGE = 'page';

export { PAGE };

function normalizeBasis(basis) {
  if (!basis) return { type: 'fraction' };
  if (typeof basis === 'string') return { type: basis };
  return { type: basis.type || 'fraction', ...(basis.viewBox ? { viewBox: basis.viewBox.slice() } : {}) };
}

export function createTargets() {
  const list = [];
  const byId = new Map();

  function add(spec) {
    if (!spec || !spec.id) return null;
    if (byId.has(spec.id)) remove(spec.id);
    const t = {
      id: spec.id,
      selector: spec.selector || null,
      node: spec.el || null,
      basis: normalizeBasis(spec.basis),
      page: !!spec.page,
    };
    byId.set(t.id, t);
    list.push(t);
    return t;
  }

  function remove(id) {
    const t = byId.get(id);
    if (!t || t.page) return null;
    byId.delete(id);
    list.splice(list.indexOf(t), 1);
    return t;
  }

  // resolved live, so a target survives the host swapping its element
  function elOf(t) {
    if (!t) return null;
    if (t.page) return document.getElementById('frame') || document.documentElement;
    if (t.selector) { try { return document.querySelector(t.selector); } catch { return null; } }
    return t.node && t.node.isConnected ? t.node : null;
  }

  function svgOf(t) {
    const el = elOf(t);
    if (!el) return null;
    if (el.tagName && el.tagName.toLowerCase() === 'svg') return el;
    return el.ownerSVGElement || null;
  }

  function viewBoxOf(t) {
    if (t.basis.viewBox) return t.basis.viewBox;
    const svg = svgOf(t);
    const raw = svg && svg.getAttribute('viewBox');
    if (!raw) return null;
    const n = raw.trim().split(/[\s,]+/).map(Number);
    return n.length === 4 && n.every(v => !isNaN(v)) ? n : null;
  }

  // the box a fraction basis is measured against
  function rectOf(t) {
    const el = elOf(t);
    if (t.page && el === document.documentElement) {
      return { left: -scrollX, top: -scrollY, width: el.scrollWidth, height: el.scrollHeight };
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  function isViewbox(t) {
    return t && t.basis.type === 'viewbox';
  }

  // screen (client px) -> the target's basis
  function toBasis(t, cx, cy) {
    if (isViewbox(t)) {
      const svg = svgOf(t);
      const m = svg && svg.getScreenCTM();
      if (!m) return null;
      const p = svg.createSVGPoint();
      p.x = cx; p.y = cy;
      const q = p.matrixTransform(m.inverse());
      return { x: q.x, y: q.y };
    }
    const r = rectOf(t);
    if (!r || !r.width || !r.height) return null;
    return { x: (cx - r.left) / r.width, y: (cy - r.top) / r.height };
  }

  // the target's basis -> screen (client px)
  function toScreen(t, x, y) {
    if (isViewbox(t)) {
      const svg = svgOf(t);
      const m = svg && svg.getScreenCTM();
      if (!m) return null;
      const p = svg.createSVGPoint();
      p.x = x; p.y = y;
      const q = p.matrixTransform(m);
      return { x: q.x, y: q.y };
    }
    const r = rectOf(t);
    if (!r || !r.width || !r.height) return null;
    return { x: r.left + x * r.width, y: r.top + y * r.height };
  }

  // a gesture binds to the innermost registered target under the pointer;
  // anything outside every target belongs to the page
  function hitTest(cx, cy) {
    let best = null, bestArea = Infinity;
    for (const t of list) {
      if (t.page) continue;
      const el = elOf(t);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      const area = r.width * r.height;
      if (area <= bestArea) { best = t; bestArea = area; }
    }
    return best || byId.get(PAGE);
  }

  add({ id: PAGE, page: true, basis: { type: 'fraction' } });

  return {
    list, byId, add, remove,
    get: id => byId.get(id),
    elOf, svgOf, viewBoxOf, rectOf, isViewbox, toBasis, toScreen, hitTest,
  };
}
