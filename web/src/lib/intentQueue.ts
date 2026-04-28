/**
 * Intent Queue — IndexedDB-backed pending-operation recovery
 *
 * Solves the force-quit problem:
 *   1. Before calling any mutating API, persist an Intent record locally.
 *   2. On every app startup, the queue worker scans for PENDING intents.
 *   3. Pending intents are replayed with their original idempotency key.
 *   4. The backend's idempotency middleware returns the cached result if
 *      the operation already completed — no duplicate side-effects.
 *
 * ─── IndexedDB schema ─────────────────────────────────────────────────────────
 *   DB:    zk_auth_intents   version: 1
 *   Store: intents           keyPath: id
 *     id:         UUID (also used as X-Idempotency-Key)
 *     type:       IntentType
 *     payload:    Record<string, unknown>
 *     status:     'PENDING' | 'COMPLETED' | 'FAILED'
 *     createdAt:  number (epoch ms)
 *     attempts:   number
 *     result?:    unknown
 *     error?:     string
 *
 * ─── Usage ────────────────────────────────────────────────────────────────────
 *
 *   // Before the API call:
 *   const intentId = await intentQueue.enqueue('ISSUE_CREDENTIAL', { userId, ... });
 *
 *   // Make the API call:
 *   const result = await api.post('/api/issuer/issue-id', body, {
 *     headers: { 'X-Idempotency-Key': intentId }
 *   });
 *
 *   // On success:
 *   await intentQueue.complete(intentId, result);
 *
 *   // On failure (or app crash — the intent stays PENDING):
 *   await intentQueue.fail(intentId, error.message);
 *
 *   // On app start — replay:
 *   await intentQueue.replayPending(handler);
 */

export type IntentType =
  | 'ISSUE_CREDENTIAL'
  | 'GENERATE_PROOF'
  | 'SUBMIT_PRESENTATION'
  | 'REGISTER_USER'
  | 'RECOVER_ACCOUNT';

export type IntentStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

export interface Intent<T = Record<string, unknown>> {
  id:        string;         // UUID v4 — also the idempotency key
  type:      IntentType;
  payload:   T;
  status:    IntentStatus;
  createdAt: number;
  attempts:  number;
  result?:   unknown;
  error?:    string;
}

const DB_NAME    = 'zk_auth_intents';
const DB_VERSION = 1;
const STORE_NAME = 'intents';
const MAX_ATTEMPTS = 5;

// ─── DB open helper ───────────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('status',    'status',    { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function txPromise<T>(
  db:   IDBDatabase,
  mode: IDBTransactionMode,
  fn:   (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const req   = fn(store);

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    tx.onerror    = () => reject(tx.error);
  });
}

// ─── IntentQueue ──────────────────────────────────────────────────────────────

export class IntentQueue {
  private _db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (typeof window === 'undefined' || !window.indexedDB) return;
    this._db = await openDB();
  }

  /** Persist a new intent and return its UUID (used as idempotency key). */
  async enqueue<T extends Record<string, unknown>>(
    type:    IntentType,
    payload: T,
  ): Promise<string> {
    if (!this._db) return crypto.randomUUID();

    const intent: Intent<T> = {
      id:        crypto.randomUUID(),
      type,
      payload,
      status:    'PENDING',
      createdAt: Date.now(),
      attempts:  0,
    };

    await txPromise(this._db, 'readwrite', (store) => store.add(intent));
    return intent.id;
  }

  /** Mark an intent as successfully completed, storing the result. */
  async complete(id: string, result: unknown): Promise<void> {
    if (!this._db) return;
    await this._patch(id, { status: 'COMPLETED', result });
  }

  /** Increment attempt count and optionally mark as FAILED. */
  async fail(id: string, error: string): Promise<void> {
    if (!this._db) return;
    const existing = await txPromise<Intent>(
      this._db, 'readonly', (store) => store.get(id),
    );
    if (!existing) return;

    const newAttempts = existing.attempts + 1;
    await this._patch(id, {
      attempts: newAttempts,
      error,
      status: newAttempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
    });
  }

  /** Retrieve all PENDING intents for replay on app startup. */
  async getPending(): Promise<Intent[]> {
    if (!this._db) return [];
    return new Promise((resolve, reject) => {
      const tx    = this._db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('status');
      const req   = index.getAll('PENDING');
      req.onsuccess = () => resolve(req.result as Intent[]);
      req.onerror   = () => reject(req.error);
    });
  }

  /**
   * Replay all PENDING intents.
   *
   * @param handler — async function that receives an intent and should
   *                  call the API with intent.id as the idempotency key.
   *                  Returns the API result on success or throws on error.
   */
  async replayPending(
    handler: (intent: Intent) => Promise<unknown>,
  ): Promise<{ replayed: number; failed: number }> {
    const pending = await this.getPending();
    let replayed  = 0;
    let failed    = 0;

    for (const intent of pending) {
      try {
        const result = await handler(intent);
        await this.complete(intent.id, result);
        replayed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.fail(intent.id, msg);
        failed++;
      }
    }

    return { replayed, failed };
  }

  /** Delete COMPLETED intents older than maxAgeMs (default 7 days). */
  async prune(maxAgeMs = 7 * 24 * 60 * 60 * 1_000): Promise<number> {
    if (!this._db) return 0;
    const cutoff = Date.now() - maxAgeMs;

    return new Promise((resolve, reject) => {
      const tx    = this._db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('createdAt');
      const range = IDBKeyRange.upperBound(cutoff);
      const req   = index.openCursor(range);
      let count   = 0;

      req.onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const intent = cursor.value as Intent;
          if (intent.status === 'COMPLETED') {
            cursor.delete();
            count++;
          }
          cursor.continue();
        } else {
          resolve(count);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async _patch(id: string, update: Partial<Intent>): Promise<void> {
    if (!this._db) return;
    const existing = await txPromise<Intent>(
      this._db, 'readonly', (store) => store.get(id),
    );
    if (!existing) return;

    await txPromise(
      this._db,
      'readwrite',
      (store) => store.put({ ...existing, ...update }),
    );
  }
}

export const intentQueue = new IntentQueue();
