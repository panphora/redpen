// redpen review — the headless engine plus the UI adapter. Builds to
// dist/redpen-review.js and exposes window.RedpenReview.mount(...): the chrome
// for answering questions a page asks about itself, and for volunteering
// comments on anything else, ending in one clipboard copy or one request to an
// agent.
import { mount } from './mount.js';
import { attach } from './wire.js';

// the review bundle keeps its own default key so nothing stored under it moves
if (!window.RedpenReview) window.RedpenReview = { mount: (o = {}) => mount({ key: 'review:' + location.pathname, ...o }) };
if (!window.RedpenWire) window.RedpenWire = { attach };
