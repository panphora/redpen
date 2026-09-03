// feedback-hub.js — the shared hub globals, kept as a stable import path. The
// dock owns the chrome now, so `register` is a no-op that says so; `json`, `off`
// and `tools` still work.
//
//   import { json, off, tools } from './feedback-hub.js';

import { installHub } from './standalone.js';

export { register, json, off, tools } from './standalone.js';

installHub();
