// notes.js — element + area + region notes, in the default standalone shape.
// The implementation now lives in the headless engine (engine.js + note-surface.js)
// and the UI adapter (mount.js + dock.js + popover.js); this module stays as the
// import-and-go entry point that pages and the homepage-illustration scenes use.
//
// Part of redpen. Load as a module (import './notes.js') or via dist/redpen.js.
// Console:   NotesTool.on(true) · NotesTool.clear() · NotesTool.layout()

import { installHub, installNotes } from './standalone.js';

installHub();
installNotes();
