// ink-layer.js — finished strokes for viewbox targets, rendered as SVG marks in
// one overlay <svg> per target that shares the target's viewBox. Because the
// overlay carries the same viewBox as the artwork, stored points need no
// scaling math, no DPR handling and no redraw on resize: only the overlay's own
// box is re-placed, and the marks land exactly where they were drawn. The
// overlay is a sibling of the target, so the host swapping its SVG leaves the
// ink untouched.

export function createInkLayer({ mount, targets }) {
  const anchor = document.createElement('div');
  anchor.className = 'laInkLayer';
  anchor.dataset.laUi = '1';
  anchor.setAttribute('sap-ignore', '');
  mount.appendChild(anchor);

  const layers = new Map();

  function layerFor(t) {
    let svg = layers.get(t.id);
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'laMarks');
      svg.dataset.laTarget = t.id;
      svg.dataset.laUi = '1';
      svg.setAttribute('sap-ignore', '');
      anchor.appendChild(svg);
      layers.set(t.id, svg);
    }
    return svg;
  }

  // The overlay is placed from the target's own getScreenCTM, not from its
  // bounding box: the CTM already accounts for borders, padding and any
  // letterboxing preserveAspectRatio introduced. Sized to exactly the rendered
  // extent of the viewBox, the overlay can then use preserveAspectRatio="none"
  // and its user units line up with the artwork's to the pixel.
  function place(t, svg) {
    const src = targets.svgOf(t);
    const vb = targets.viewBoxOf(t);
    const m = src && src.getScreenCTM();
    if (!m || !vb) return false;
    const p = src.createSVGPoint();
    p.x = vb[0]; p.y = vb[1];
    const a = p.matrixTransform(m);
    p.x = vb[0] + vb[2]; p.y = vb[1] + vb[3];
    const b = p.matrixTransform(m);
    if (!(b.x - a.x) || !(b.y - a.y)) return false;
    const base = anchor.getBoundingClientRect();
    svg.setAttribute('viewBox', vb.join(' '));
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.left = (a.x - base.left) + 'px';
    svg.style.top = (a.y - base.top) + 'px';
    svg.style.width = (b.x - a.x) + 'px';
    svg.style.height = (b.y - a.y) + 'px';
    return true;
  }

  function pathData(points) {
    if (!points.length) return '';
    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length; i++) d += ` L ${points[i][0]} ${points[i][1]}`;
    return d;
  }

  // repaint one target's ink; `show` decides whether it is visible at all
  function render(t, strokes, show) {
    const svg = layerFor(t);
    svg.style.display = show ? '' : 'none';
    if (!show) return;
    if (!place(t, svg)) { svg.style.display = 'none'; return; }
    svg.textContent = '';
    for (const s of strokes) {
      if (!s.points || !s.points.length) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData(s.points));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', s.color || '#000');
      path.setAttribute('stroke-width', s.width || 3);
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      path.dataset.laStroke = s.id;
      svg.appendChild(path);
    }
  }

  function drop(id) {
    layers.get(id)?.remove();
    layers.delete(id);
  }

  function destroy() {
    anchor.remove();
    layers.clear();
  }

  return { render, drop, destroy, anchor };
}
