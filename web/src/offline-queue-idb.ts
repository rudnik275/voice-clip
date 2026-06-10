// ---- Browser IndexedDB implementation of the core OfflineQueue port ----
//
// Deliberately thin and dumb: raw IndexedDB wrapped in promises, no library
// (issue #140 — no new npm deps). All queue LOGIC (what to enqueue, drain
// order, single-flight, delete-only-on-2xx) lives in core/offline-sync.ts and
// is unit-tested there with a fake; this file is only the storage shim.
//
// DB name `voice-clip` / store `queue` / key `localId` match the pre-Vue app
// (CLAUDE.md "Offline protocol"), so clips queued by the old app.ts survive
// the rewrite and drain on the first load of the SPA.
//
// Bun's test runtime has no `indexedDB`, so this adapter has no unit tests —
// it is covered by the manual airplane-mode check in the PR.

import type { OfflineQueue, QueuedClip } from '../../core/offline-sync';

const DB_NAME = 'voice-clip';
const STORE = 'queue';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'localId' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error('IndexedDB open failed'));
    open.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

export function createIdbOfflineQueue(): OfflineQueue {
  // Cache the connection; if it ever errors, the next op re-opens.
  let dbPromise: Promise<IDBDatabase> | null = null;
  function db(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = openDb().catch((err) => {
        dbPromise = null;
        throw err;
      });
    }
    return dbPromise;
  }

  return {
    async put(item: QueuedClip): Promise<void> {
      const d = await db();
      await req(d.transaction(STORE, 'readwrite').objectStore(STORE).put(item));
    },

    async list(): Promise<QueuedClip[]> {
      const d = await db();
      const all = await req(d.transaction(STORE, 'readonly').objectStore(STORE).getAll());
      return all as QueuedClip[];
    },

    async delete(localId: string): Promise<void> {
      const d = await db();
      await req(d.transaction(STORE, 'readwrite').objectStore(STORE).delete(localId));
    },
  };
}
