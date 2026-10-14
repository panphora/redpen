// backend.js — where a redpen blob actually lives.
//
// IndexedDB first, the injected synchronous storage second.
//
// localStorage was the original home and is the reason this file exists: a few
// megabytes per ORIGIN, shared with whatever else that origin stores, and a full
// one makes setItem throw. redpen rewrites its whole blob on every note, so one
// failed write meant every later write failed too — silently, because nothing
// watched. IndexedDB has a far larger budget and reports failure per write.
//
// Everything here degrades. A browser with IDB disabled, a private window, or an
// open() that throws falls back to the synchronous storage and behaves exactly as
// redpen always did, which is also what keeps the injectable `storage` contract
// meaningful for tests.

const DB = 'redpen';
const STORE = 'blobs';

function openDB() {
  return new Promise(resolve => {
    let req;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) return resolve(null);
      req = indexedDB.open(DB, 1);
    } catch {
      return resolve(null);
    }
    // onblocked resolves early, but the open request can still succeed
    // afterwards: that connection is closed rather than left open with nobody
    // holding it. Unreachable while the version is pinned at 1; it becomes a
    // real hazard the day the schema moves.
    let settled = false;
    const settle = db => {
      if (settled) { db?.close?.(); return; }
      settled = true;
      resolve(db);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => settle(req.result);
    req.onerror = () => settle(null);
    req.onblocked = () => settle(null);
  });
}

function transact(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let t, req;
    try {
      t = db.transaction(STORE, mode);
      req = fn(t.objectStore(STORE));
    } catch (err) {
      return reject(err);
    }
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onabort = () => reject(t.error || new Error('redpen: idb transaction aborted'));
    t.onerror = () => reject(t.error || new Error('redpen: idb transaction failed'));
  });
}

export function createBackend({ key, storage }) {
  const blobKey = 'redpen:' + key;
  const dbReady = openDB();

  function readLocal() {
    try { return JSON.parse(storage.getItem(blobKey) || 'null'); } catch { return null; }
  }

  return {
    // The durable blob, or null. Never rejects: a read that fails is an empty
    // redpen, not a broken page.
    async read() {
      const db = await dbReady;
      if (!db) return readLocal();
      // A read that FAILS must propagate, never fall through to the localStorage
      // copy. Adopting the stale blob after an aborted read writes it on top of
      // whatever is really in IndexedDB, which is how one transient abort turns
      // into permanent loss. The store goes read-only instead.
      const found = await transact(db, 'readonly', s => s.get(blobKey));
      if (found) return found;
      // First run since the move: adopt what localStorage holds and LEAVE the
      // original in place, so rolling back to an older build loses nothing.
      const legacy = readLocal();
      if (legacy) {
        try { await transact(db, 'readwrite', s => s.put(legacy, blobKey)); } catch { /* reported on the next real write */ }
      }
      return legacy;
    },

    // REJECTS on failure, deliberately: the caller has to be able to tell the
    // user their notes are not being kept.
    async write(blob) {
      const db = await dbReady;
      if (!db) return storage.setItem(blobKey, JSON.stringify(blob));
      await transact(db, 'readwrite', s => s.put(blob, blobKey));
    },
  };
}

// The page itself, for hosts that save the document. The blob lives as JSON text
// in <script type="application/json" id="redpen-data">, so the file carries its
// own review and anything that reads the file reads the comments too.
export const PAGE_BLOCK_ID = 'redpen-data';

export function findPageBlock(doc = document) {
  const node = doc.getElementById(PAGE_BLOCK_ID);
  return node && node.tagName === 'SCRIPT' && /json/i.test(node.type) ? node : null;
}

// `<` is escaped so a comment that says </script> cannot end the block early
const blockText = blob => JSON.stringify(blob).replace(/</g, '\\u003c');

async function saveThroughClay() {
  const clay = window.clay;
  if (!clay) return;
  if (clay.ready && typeof clay.ready.then === 'function') await clay.ready.catch(() => {});
  if (typeof clay.save === 'function') await clay.save();
}

export function createPageBackend({ doc = document, save = saveThroughClay } = {}) {
  // looked up on every call: a live-sync apply from disk may swap the element
  const block = () => findPageBlock(doc);
  return {
    async read() {
      const text = block()?.textContent.trim() || '';
      return text ? JSON.parse(text) : null;
    },
    async write(blob) {
      const node = block();
      if (!node) throw new Error('redpen: the #redpen-data block is gone from the page');
      const text = blockText(blob);
      if (node.textContent === text) return;
      node.textContent = text;
      await save();
    },
  };
}
