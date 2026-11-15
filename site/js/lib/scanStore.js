/**
 * Scanner device storage (IndexedDB). Holds:
 *   kv.deviceKey   { privateKey: CryptoKey (non-extractable), publicJwk }  never leaves the device
 *   kv.pass        clinician pass token (server-signed, bound to this device key)
 *   kv.cardStatus:<sub>:<version>   'superseded' | 'revoked' from the last sync
 *   queue          signed scan events waiting to upload (keyPath eventId)
 * Callers must handle rejections: IndexedDB can be unavailable (private mode, storage blocked).
 */
const DB_NAME = 'medistry-scan';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'eventId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => { dbPromise = null; throw err; });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kvGet = (key) => run('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key, value) => run('kv', 'readwrite', (s) => { s.put(value, key); });
export const kvDelete = (key) => run('kv', 'readwrite', (s) => { s.delete(key); });
export const queueAdd = (event) => run('queue', 'readwrite', (s) => { s.put(event); });
export const queueAll = () => run('queue', 'readonly', (s) => s.getAll());
export const queueDelete = (ids) => run('queue', 'readwrite', (s) => { for (const id of ids) s.delete(id); });

/** The device's ECDSA P-256 key pair; created once, private key non-extractable. */
export async function getOrCreateDeviceKey(subtle = globalThis.crypto.subtle) {
  const existing = await kvGet('deviceKey');
  if (existing && existing.privateKey && existing.publicJwk) return existing;
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', kp.publicKey);
  const record = { privateKey: kp.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
  await kvSet('deviceKey', record);
  return record;
}
