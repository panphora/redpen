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
