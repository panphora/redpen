// identify.js — element identity for redpen notes: a stable-ish css path plus a
// descriptive record (tag/id/classes/text/ancestors) so a pasted JSON note pins
// the exact element. Pure functions, no DOM injection.

export function nthOfType(el) {
  const p = el.parentElement;
  if (!p) return 0;
  const sibs = [...p.children].filter(s => s.tagName === el.tagName);
  return sibs.length > 1 ? sibs.indexOf(el) + 1 : 0;
}

export function cssPath(el) {
  if (el === document.body) return 'body';
  if (el === document.documentElement) return 'html';
  const parts = [];
  for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    let seg = n instanceof SVGElement ? n.tagName : n.tagName.toLowerCase();
    if (n.id) { parts.unshift(seg + '#' + CSS.escape(n.id)); break; }
    seg += [...n.classList].slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
    const nth = nthOfType(n);
    if (nth) seg += `:nth-of-type(${nth})`;
    parts.unshift(seg);
  }
  return parts.join(' > ');
}

export function describe(el, lite) {
  const t = { selector: cssPath(el), tag: el.tagName.toLowerCase() };
  if (el.id) t.id = el.id;
  if (el.classList.length) t.classes = [...el.classList];
  const nth = nthOfType(el);
  if (nth) t.nth = nth;
  const text = ((el.innerText ?? el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, lite ? 60 : 100);
  if (text) t.text = text;
  if (lite) return t;
  const ancestors = [];
  for (let n = el.parentElement, i = 0; n && i < 4 && n !== document.body && n !== document.documentElement; n = n.parentElement, i++) {
    const a = { tag: n.tagName.toLowerCase() };
    if (n.id) a.id = n.id;
    if (n.classList.length) a.classes = [...n.classList];
    const an = nthOfType(n);
    if (an) a.nth = an;
    ancestors.push(a);
  }
  if (ancestors.length) t.ancestors = ancestors;
  return t;
}

export function resolve(target) {
  if (!target || !target.selector) return null;
  try { return document.querySelector(target.selector); } catch { return null; }
}

// the region basis: nearest graphic up the tree (for svg, the outermost <svg>)
export function graphicBasis(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const t = n.tagName.toLowerCase();
    if (t === 'canvas' || t === 'img' || t === 'video') return n;
    if (t === 'svg' && !n.ownerSVGElement) return n;
  }
  return null;
}

export function topElementAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest('[data-la-ui]')) continue;
    return el;
  }
  return document.body;
}
