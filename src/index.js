// redpen — the headless engine plus the one UI adapter, in one import. Builds to
// dist/redpen.js: element/area/region comments, freehand ink, the dock and its
// export control, and the old entry points kept as aliases.
import { create, CFG } from './engine.js';
import { describe, cssPath, resolve } from './identify.js';
import { attach } from './wire.js';
import { installHub, installNotes, installDraw, mountOnce } from './standalone.js';

if (!window.Redpen) window.Redpen = { create, cfg: CFG, describe, cssPath, resolve, mount: mountOnce };
if (!window.RedpenReview) window.RedpenReview = { mount: mountOnce };
if (!window.RedpenWire) window.RedpenWire = { attach };

installHub();
installNotes();
installDraw();
