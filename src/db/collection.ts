import type { CollectionEntry } from '../lib/types'

const DB_NAME = 'pokesearch'
const STORE = 'collection'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'uid' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    t.oncomplete = () => db.close()
  })
}

export async function listCollection(): Promise<CollectionEntry[]> {
  const all = await tx<CollectionEntry[]>('readonly', (s) => s.getAll())
  return all.sort((a, b) => b.addedAt.localeCompare(a.addedAt))
}

export function putEntry(e: CollectionEntry): Promise<IDBValidKey> {
  return tx('readwrite', (s) => s.put(e))
}

export function deleteEntry(uid: string): Promise<undefined> {
  return tx('readwrite', (s) => s.delete(uid))
}

export function newUid(): string {
  return crypto.randomUUID()
}

export async function exportCollection(): Promise<string> {
  return JSON.stringify(await listCollection(), null, 2)
}

export async function importCollection(json: string): Promise<number> {
  const entries = JSON.parse(json) as CollectionEntry[]
  if (!Array.isArray(entries)) throw new Error('invalid export file')
  let n = 0
  for (const e of entries) {
    if (e && typeof e.uid === 'string' && typeof e.cardId === 'string') {
      await putEntry(e)
      n++
    }
  }
  return n
}

/**
 * Entries whose price is older than maxAgeHours (default: daily refresh) or
 * priced in a different currency than the current display currency.
 */
export function staleEntries(
  entries: CollectionEntry[],
  maxAgeHours = 24,
  currency = 'USD',
): CollectionEntry[] {
  const cutoff = Date.now() - maxAgeHours * 3600_000
  return entries.filter(
    (e) =>
      !e.lastPricedAt ||
      new Date(e.lastPricedAt).getTime() < cutoff ||
      (e.range && e.range.currency !== currency),
  )
}
