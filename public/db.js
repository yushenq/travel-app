// Tiny IndexedDB wrapper: everything the app needs offline lives here.
// Stores: kv (snapshot, settings), outbox (changes waiting to upload), blobs (photo files by path).
const DB_NAME = 'travel-app';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const put = (store, value, key) => tx(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const all = store => tx(store, 'readonly', s => s.getAll());
export const count = store => tx(store, 'readonly', s => s.count());
export const keys = store => tx(store, 'readonly', s => s.getAllKeys());
