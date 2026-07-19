// redpen — element/area notes + freehand ink + COPY JSON, in one import.
// Builds to dist/redpen.js: the headless engine plus the default UI adapter.
import { installHub, installNotes, installDraw } from './standalone.js';

installHub();
installNotes();
installDraw();
