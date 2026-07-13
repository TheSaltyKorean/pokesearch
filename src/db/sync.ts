import type { CollectionEntry, Settings } from '../lib/types'
import { listCollection, putEntry, deleteEntry } from './collection'

/**
 * Collection sync through the price-proxy Worker (Settings → workerUrl +
 * syncToken). Concurrency model: server-issued revisions plus a local dirty
 * flag — no client clocks anywhere, so a skewed device clock can't poison
 * ordering.
 *
 * - Every server blob carries a `rev`. The client remembers the last rev it
 *   reconciled with and whether it has unpushed local changes (dirty).
 * - Pull (app open / settings save): clean + rev changed → adopt the server
 *   copy wholesale (deletes propagate); dirty → push instead.
 * - Push: PUT {baseRev, entries}. A 409 returns the current server blob;
 *   the client merges (local wins per uid, server-only rows kept), adopts
 *   the fresh rev, and retries.
 * - A browser's first-ever reconcile union-merges both sides so neither
 *   collection is clobbered.
 * Residual v1 edge (documented): a row deleted on this device while another
 * device edited concurrently can resurrect through the 409 union-merge.
 */

const SERVER_REV_KEY = 'pokesearch.collection.serverRev'
const DIRTY_KEY = 'pokesearch.collection.dirty'
// Set once this browser has reconciled with the server at least once; local
// edits can predate sync being configured, so dirtiness alone can't tell a
// first sync from a routine one.
const EVER_SYNCED_KEY = 'pokesearch.collection.everSynced'
const PUSH_DEBOUNCE_MS = 3000
const PUSH_MAX_RETRIES = 3
// fetch(keepalive) rejects bodies over 64KB (in bytes, not string length);
// only the page-hide flush needs keepalive.
const KEEPALIVE_MAX_BYTES = 60_000

interface ServerBlob {
  rev: string | null
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

/** Flag unpushed local changes; cleared only when a push lands (200). */
export function markCollectionMutated(): void {
  localStorage.setItem(DIRTY_KEY, '1')
}

const isDirty = () => Boolean(localStorage.getItem(DIRTY_KEY))
const serverRev = () => localStorage.getItem(SERVER_REV_KEY)

function adoptRev(rev: string | null): void {
  if (rev === null) localStorage.removeItem(SERVER_REV_KEY)
  else localStorage.setItem(SERVER_REV_KEY, rev)
}

// Bumped whenever sync settings change/reconcile restarts; in-flight timers
// and responses from the previous configuration check it and stand down.
let generation = 0
let pushTimer: ReturnType<typeof setTimeout> | undefined
let pendingSettings: Settings | undefined
// Mirrors settledPromise for sync consumers (the page-hide flush) that
// cannot await.
let settledState: 'ok' | 'failed' = 'ok'

async function pushNow(settings: Settings, attempt = 0, flush = false): Promise<void> {
  const gen = generation
  const ep = endpoint(settings)
  if (!ep) return
  const entries = await listCollection()
  const body = JSON.stringify({ baseRev: serverRev(), entries })
  let res: Response
  try {
    res = await fetch(ep.url, {
      method: 'PUT',
      headers: { ...ep.headers, 'Content-Type': 'application/json' },
      body,
      // Lets a page-hide flush outlive the page; byte-limited by browsers.
      keepalive: flush && new TextEncoder().encode(body).length < KEEPALIVE_MAX_BYTES,
    })
  } catch (err) {
    return retryPush(settings, attempt, err, gen)
  }
  if (gen !== generation) return // settings changed mid-flight; discard
  if (res.status === 409) {
    // Another device advanced the rev. Merge: local wins per uid (these are
    // the user's most recent edits), server-only rows are kept.
    const server: ServerBlob = await res.json()
    const localByUid = new Map(entries.map((e) => [e.uid, e]))
    for (const e of server.entries) {
      if (!localByUid.has(e.uid)) await putEntry(e)
    }
    adoptRev(server.rev)
    if (attempt < PUSH_MAX_RETRIES) return pushNow(settings, attempt + 1)
    console.warn('collection push gave up after repeated conflicts')
    return
  }
  // KV allows ~1 write/second on the same key; a same-second push from
  // another device surfaces here as 429/5xx and just needs another try.
  if (res.status === 429 || res.status >= 500) return retryPush(settings, attempt, res.status, gen)
  if (!res.ok) {
    console.warn('collection push failed:', res.status)
    return
  }
  const { rev } = await res.json()
  if (gen !== generation) return
  adoptRev(rev ?? null)
  localStorage.removeItem(DIRTY_KEY)
}

function retryPush(settings: Settings, attempt: number, why: unknown, gen: number): void {
  if (attempt >= PUSH_MAX_RETRIES) {
    console.warn('collection push gave up:', why)
    return
  }
  setTimeout(
    () => {
      if (gen === generation) void pushNow(settings, attempt + 1)
    },
    1500 * (attempt + 1) + Math.random() * 1000,
  )
}

/** Debounced whole-collection upload; safe to call after every mutation. */
export function schedulePush(settings: Settings): void {
  if (!endpoint(settings)) return
  pendingSettings = settings
  clearTimeout(pushTimer)
  const gen = generation
  pushTimer = setTimeout(async () => {
    pushTimer = undefined
    // A mutation made while the startup pull is in flight stays dirty; wait
    // for the pull so the push carries the reconciled DB. If the pull
    // failed we can't know what the server holds — keep it local for now.
    if ((await whenSyncSettled()) === 'failed' || gen !== generation) {
      if (gen === generation) console.warn('collection push skipped: startup sync failed')
      return
    }
    void pushNow(settings)
  }, PUSH_DEBOUNCE_MS)
}

/** Drop queued/in-flight pushes; the next reconcile decides what syncs. */
function cancelPendingPush(): void {
  generation++
  clearTimeout(pushTimer)
  pushTimer = undefined
  pendingSettings = undefined
}

// An edit made just before closing the tab must not die in the debounce
// timer — flush it the moment the page hides (but never before the startup
// sync succeeded: the flush can't await the pull, and pushing a pre-pull DB
// would overwrite server state this session never saw).
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'hidden' &&
      pushTimer !== undefined &&
      pendingSettings &&
      settledState === 'ok' &&
      isDirty()
    ) {
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
 * deleted would resurrect them.
 */
export function whenSyncSettled(): Promise<'ok' | 'failed'> {
  return settledPromise
}

/**
 * Pull the server blob and reconcile. Also called after saving sync
 * settings, so enabling/changing sync reconciles without a reload.
 */
export async function syncOnOpen(
  settings: Settings,
): Promise<'pulled' | 'pushed' | 'merged' | 'noop'> {
  // Pushes queued under the previous settings must not fire against an old
  // endpoint/token; this reconcile supersedes them.
  cancelPendingPush()
  const run = (async () => {
    const ep = endpoint(settings)
    if (!ep) return 'noop' as const
    const res = await fetch(ep.url, { headers: ep.headers })
    if (!res.ok) throw new Error(`sync pull ${res.status}`)
    const server: ServerBlob = await res.json()
    const current = await listCollection()
    const everSynced = Boolean(localStorage.getItem(EVER_SYNCED_KEY))

    // First reconcile of a browser that already had cards: union-merge both
    // sides so neither collection is clobbered, then push the union.
    if (!everSynced && current.length > 0) {
      const localByUid = new Set(current.map((e) => e.uid))
      for (const e of server.entries) {
        if (!localByUid.has(e.uid)) await putEntry(e)
      }
      adoptRev(server.rev)
      markCollectionMutated()
      localStorage.setItem(EVER_SYNCED_KEY, '1')
      await pushNow(settings)
      return 'merged' as const
    }

    let outcome: 'pulled' | 'pushed' | 'noop' = 'noop'
    if (isDirty()) {
      // Local unpushed changes win locally; conflicts merge via the 409
      // path inside pushNow.
      schedulePush(settings)
      outcome = 'pushed'
    } else if ((server.rev ?? null) !== (serverRev() ?? null)) {
      const keep = new Set(server.entries.map((e) => e.uid))
      for (const e of current) {
        if (!keep.has(e.uid)) await deleteEntry(e.uid)
      }
      for (const e of server.entries) await putEntry(e)
      adoptRev(server.rev)
      outcome = 'pulled'
    }
    localStorage.setItem(EVER_SYNCED_KEY, '1')
    return outcome
  })()
  settledPromise = run.then(
    () => {
      settledState = 'ok'
      return 'ok' as const
    },
    () => {
      settledState = 'failed'
      return 'failed' as const
    },
  )
  return run
}
