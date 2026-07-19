// redpen core — the headless engine alone. Builds to dist/redpen-core.js and
// exposes window.Redpen.create(...): data, pointer surfaces, events and methods,
// with zero chrome, no global keyboard and no clipboard. The host owns the UI.
import { create, CFG } from './engine.js';
import { describe, cssPath, resolve } from './identify.js';

if (!window.Redpen) window.Redpen = { create, cfg: CFG, describe, cssPath, resolve };
