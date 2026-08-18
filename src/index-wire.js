// redpen wire — the transport bundle. Builds to dist/redpen-wire.js and exposes
// window.RedpenWire.attach(review): a finished comment becomes a request to a
// local process over clay.wire, and that process edits the file.
import { attach } from './wire.js';

if (!window.RedpenWire) window.RedpenWire = { attach };
