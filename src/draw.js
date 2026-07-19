// draw.js — freehand ink, in the default standalone shape. The implementation
// now lives in the headless engine (engine.js + draw-surface.js) and the default
// UI adapter (ui.js); this module stays as the import-and-go entry point that
// pages and the homepage-illustration scenes already use.
//
// Part of redpen. Load as a module (import './draw.js') or via dist/redpen.js.
// Console tuning:          DrawTool.tune({ lazyRadius: 6, slowBlend: 0.5 })
// Undo while drawing:      cmd/ctrl+Z   ·   DrawTool.undo()   ·   DrawTool.clear()

import { installHub, installDraw } from './standalone.js';

installHub();
installDraw();
