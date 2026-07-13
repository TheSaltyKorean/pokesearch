import type { CollectionEntry, Settings } from '../lib/types'
import { listCollection, putEntry, deleteEntry } from './collection'

/**
 * Collection sync through the price-proxy Worker (Settings → workerUrl +
 * syncToken). The whole collection is one blob with last-write-wins at blob
 * level: whichever side has the newer `updatedAt` replaces the other, and
 * the Worker rejects (409) writes older than what it already holds. The
 * first sync from a browser that already had a local collection is a
 * union-merge so neither side's cards are lost. Fine for one person on a
 * few devices; concurrent edits inside one sync window lose one side.
 */

const LAST_MUTATED_KEY = 'pokesearch.collection.mutatedAt'
// mutatedAt is written by local edits whether or not sync is configured, so
// "has this browser ever reconciled with the server" needs its own flag —
// it decides when the union-merge seeding path runs.
const EVER_SYNCED_KEY = 'pokesearch.collection.everSynced'
const PUSH_DEBOUNCE_MS = 3000
const PUSH_MAX_RETRIES = 3
// fetch(keepalive) rejects bodies over 64KB; only the page-hide flush needs it
const KEEPALIVE_MAX_BYTES = 60_000

interface SyncBlob {
  updatedAt: string | null
  entries: CollectionEntry[]
}

function endpoint(
  settings: Settings,
): { url: string; headers: Record<string, string> } | undefined {
  if (!settings.workerUrl || !settings.syncToken) return undefined
  return {
    url: `${settings.workerUrl.replace(/\/+$/, '')}/collection`,
    headers: { Authorization: `Bearer ${settings.syncToken}` },
  }
}

export function markCollectionMutated(): void {
  localStorage.setItem(LAST_MUTATED_KEY, new Date().toISOString())
}

function lastMutatedAt(): string {
  return localStorage.getItem(LAST_MUTATED_KEY) ?? ''
}

let pushTimer: ReturnType<typeof setTimeout> | undefined
let pendingSettings: Settings | undefined

async function pushNow(settings: Settings, attempt = 0, flush = false): Promise<void> {
  const ep = endpoint(settings)
  if (!ep) return
  const entries = await listCollection()
  const body = JSON.stringify({
    updatedAt: lastMutatedAt() || new Date().toISOString(),
    entries,
  } satisfies SyncBlob)
  let res: Response
  try {
    res = await fetch(ep.url, {
      method: 'PUT',
      headers: { ...ep.headers, 'Content-Type': 'application/json' },
      body,
      // Lets a page-hide flush outlive the page; capped by the browser.
      keepalive: flush && body.length < KEEPALIVE_MAX_BYTES,
    })
  } catch (err) {
    return retryPush(settings, attempt, err)
  }
  if (res.status === 409) {
    // Another device wrote a newer blob first: adopt the server state.
    await syncOnOpen(settings).catch(() => {})
    return
  }
  // KV allows ~1 write/second on the same key; a same-second push from
  // another device surfaces here as 429/5xx and just needs another try.
  if (res.status === 429 || res.status >= 500) return retryPush(settings, attempt, res.status)
  if (!res.ok) console.warn('collection push failed:', res.status)
}

function retryPush(settings: Settings, attempt: number, why: unknown): void {
  if (attempt >= PUSH_MAX_RETRIES) {
    console.warn('collection push gave up:', why)
    return
  }
  setTimeout(
    () => void pushNow(settings, attempt + 1),
    1500 * (attempt + 1) + Math.random() * 1000,
  )
}

/** Debounced whole-collection upload; safe to call after every mutation. */
export function schedulePush(settings: Settings): void {
  if (!endpoint(settings)) return
  pendingSettings = settings
  clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = undefined
    void pushNow(settings)
  }, PUSH_DEBOUNCE_MS)
}

// An edit made just before closing the tab must not die in the debounce
// timer — flush it the moment the page hides.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pushTimer !== undefined && pendingSettings) {
      clearTimeout(pushTimer)
      pushTimer = undefined
      void pushNow(pendingSettings, 0, true)
    }
  })
}

let settledPromise: Promise<'ok' | 'failed'> = Promise.resolve('ok')

/**
 * Resolves when the startup sync has settled — 'failed' when sync is
 * configured but the pull didn't complete. Consumers that snapshot and then
 * write back the local DB (CollectionView's stale-refresh) must wait for
 * this and STOP on 'failed': pushing rows the unreachable server blob had
 * deleted would resurrect them with a newer timestamp.
 */
export function whenSyncSettled(): Promise<'ok' | 'failed'> {
  return settledPromise
}

/**
 * Pull the server blob and reconcile. Also called after saving sync
 * settings, so enabling sync reconciles without a reload.
 */
export async function syncOnOpen(
  settings: Settings,
): Promise<'pulled' | 'pushed' | 'merged' | 'noop'> {
  const run = (async () => {
    const ep = endpoint(settings)
    if (!ep) return 'noop' as const
    const res = await fetch(ep.url, { headers: ep.headers })
    if (!res.ok) throw new Error(`sync pull ${res.status}`)
    const server: SyncBlob = await res.json()
    const local = lastMutatedAt()
    const current = await listCollection()
    const everSynced = Boolean(localStorage.getItem(EVER_SYNCED_KEY))

    // First reconcile of a browser that already had cards. Local edits may
    // have stamped mutatedAt long before sync was configured, so the flag —
    // not the timestamp — decides. Union-merge both sides so neither
    // collection is clobbered.
    if (!everSynced && current.length > 0) {
      const byUid = new Map(server.entries.map((e) => [e.uid, e]))
      for (const e of current) if (!byUid.has(e.uid)) byUid.set(e.uid, e)
      for (const e of byUid.values()) await putEntry(e)
      markCollectionMutated()
      await pushNow(settings)
      localStorage.setItem(EVER_SYNCED_KEY, '1')
      return 'merged' as const
    }

    let outcome: 'pulled' | 'pushed' | 'noop' = 'noop'
    if (server.updatedAt && server.updatedAt > local) {
      const keep = new Set(server.entries.map((e) => e.uid))
      for (const e of current) {
        if (!keep.has(e.uid)) await deleteEntry(e.uid)
      }
      for (const e of server.entries) await putEntry(e)
      localStorage.setItem(LAST_MUTATED_KEY, server.updatedAt)
      outcome = 'pulled'
    } else if (local && local > (server.updatedAt ?? '')) {
      schedulePush(settings)
      outcome = 'pushed'
    }
    localStorage.setItem(EVER_SYNCED_KEY, '1')
    return outcome
  })()
  settledPromise = run.then(
    () => 'ok' as const,
    () => 'failed' as const,
  )
  return run
}
