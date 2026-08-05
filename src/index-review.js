// redpen review — the headless engine plus the review adapter. Builds to
// dist/redpen-review.js and exposes window.RedpenReview.mount(...): the chrome
// for answering questions a page asks about itself, and for volunteering
// comments on anything else, ending in one clipboard copy.
import { mount } from './review.js';

if (!window.RedpenReview) window.RedpenReview = { mount };
