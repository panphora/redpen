// feedback-hub.js — the shared chrome + copy registry, kept as a stable import
// path. It now re-exports the default UI adapter's hub (ui.js), which is where
// the bar, the pills, the include-checkboxes and COPY JSON live.
//
//   import { register } from './feedback-hub.js';
//   const handle = register({ id, label, labelOn, getOn, setOn, clear, getData });
//   handle.setOn(v)   // toggle from outside; keeps the pill in sync

import { installHub } from './standalone.js';

export { register, json, off, tools } from './ui.js';

installHub();
