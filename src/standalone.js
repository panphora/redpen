// standalone.js — the default redpen experience: one adapter per page, keyed by
// the page path and mounted on document.body, plus the NotesTool / DrawTool /
// FeedbackHub globals that pages and the homepage-illustration scenes already
// call.
//
// The two tools install independently (a page may load only draw.js), and each
// install is idempotent, so a second bundle evaluation can't replace the live
// globals with empty ones.

import { mount } from './mount.js';
import { CFG } from './draw-surface.js';

let instance = null;

// One adapter per page. The bundle mounts on load, and a host that then calls
// Redpen.mount() or RedpenReview.mount() gets that adapter back instead of a
// second dock over the same storage key.
export function mountOnce(opts = {}) {
  // a host whose pages differ only by query string (one page, many subjects)
  // sets window.REDPEN_KEY before this bundle loads to get its own notes blob
  // and window.REDPEN_OPTIONS (e.g. { hidden: true }) for any other mount option
  if (!instance) instance = mount({ key: window.REDPEN_KEY ?? location.pathname, ...(window.REDPEN_OPTIONS || {}), ...opts });
  return instance;
}

export function review() {
  return mountOnce();
}

export function pen() {
  return review().pen;
}

const tool = (id, mode) => ({
  id,
  getOn: () => review().pen.mode() === mode,
  setOn: v => review().mode(v ? mode : null),
});

// four scene pages under ARCHIVE_PROJECTS/experiments/homepage-illustrations read
// FeedbackHub.tools.some(t => t.getOn()) to know whether a redpen mode is on
export const tools = [tool('notes', 'note'), tool('draw', 'draw')];

export function json() {
  return JSON.stringify(review().json(), null, 2);
}

export function off() {
  review().mode(null);
}

export function register() {
  console.warn('[redpen] FeedbackHub.register is gone: the dock has a fixed set of tools');
  return { setOn() {} };
}

export function installNotes() {
  if (!window.NotesTool) {
    review();
    window.NotesTool = {
      on: v => tools[0].setOn(v),
      clear: () => pen().clearNotes(),
      layout: () => pen().layout(),
      items: () => pen().items(),
    };
  }
  return window.NotesTool;
}

export function installDraw() {
  if (!window.DrawTool) {
    review();
    window.DrawTool = {
      cfg: CFG,
      tune: o => Object.assign(CFG, o),
      on: v => tools[1].setOn(v),
      undo: () => pen().undoStroke(),
      clear: () => pen().clearStrokes(),
    };
    Object.defineProperty(window.DrawTool, 'strokes', { get: () => pen().strokes(), enumerable: true });
  }
  return window.DrawTool;
}

export function installHub() {
  // a second bundle evaluation must not replace the live registry with an empty one
  if (!window.FeedbackHub) window.FeedbackHub = { register, json, off, tools };
  return window.FeedbackHub;
}
