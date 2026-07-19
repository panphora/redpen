// standalone.js — the default redpen experience, composed from the headless
// engine plus the default UI adapter. One instance per page, keyed by the page
// path, mounted on document.body, with the hub bar, the #laNotes panel and the
// global cmd+Z.
//
// The two tools install independently (a page may load only draw.js), and each
// install is idempotent, so a second bundle evaluation can't replace the live
// registry with an empty one.

import { create } from './engine.js';
import { CFG } from './draw-surface.js';
import { register, json, off, tools, syncPills, setDataSource, attachNotesPanel, attachKeys } from './ui.js';

let instance = null;

export function pen() {
  if (!instance) {
    instance = create({ key: location.pathname, mount: document.body });
    instance.addEventListener('mode', syncPills);
    attachKeys(instance);
    // COPY JSON exports every target; the include-checkboxes drop sections
    setDataSource(include => {
      const d = instance.data();
      for (const g of Object.values(d.targets)) {
        if (!include.notes) delete g.notes;
        if (!include.draw) delete g.strokes;
      }
      return d;
    });
  }
  return instance;
}

export function installNotes() {
  if (window.NotesTool) return window.NotesTool;
  const p = pen();
  attachNotesPanel(p);
  const handle = register({
    id: 'notes',
    label: 'NOTES',
    getOn: () => p.mode() === 'note',
    setOn: v => p.setMode(v ? 'note' : (p.mode() === 'note' ? null : p.mode())),
    clear: () => p.clearNotes(),
  });
  window.NotesTool = {
    on: v => handle.setOn(v),
    clear: () => p.clearNotes(),
    layout: () => p.layout(),
    items: () => p.items(),
  };
  return window.NotesTool;
}

export function installDraw() {
  if (window.DrawTool) return window.DrawTool;
  const p = pen();
  const handle = register({
    id: 'draw',
    label: 'DRAW',
    labelOn: 'DRAWING',
    getOn: () => p.mode() === 'draw',
    setOn: v => p.setMode(v ? 'draw' : (p.mode() === 'draw' ? null : p.mode())),
    clear: () => p.clearStrokes(),
  });
  window.DrawTool = {
    cfg: CFG,
    tune: o => Object.assign(CFG, o),
    on: v => handle.setOn(v),
    undo: () => p.undoStroke(),
    clear: () => p.clearStrokes(),
  };
  Object.defineProperty(window.DrawTool, 'strokes', { get: () => p.strokes(), enumerable: true });
  return window.DrawTool;
}

export function installHub() {
  // a second bundle evaluation must not replace the live registry with an empty one
  if (!window.FeedbackHub) window.FeedbackHub = { register, json, off, tools };
  return window.FeedbackHub;
}
