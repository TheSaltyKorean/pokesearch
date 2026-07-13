/**
 * pokesearch-prices — Cloudflare Worker that holds the pricing API keys
 * server-side so the static SPA needs no per-user keys, and proxies sources
 * that lack CORS (eBay). Read-only by design: only GET passthroughs to
 * price-reading endpoints are exposed; marketplace/write APIs are not.
 *
 * Routes (all GET):
 *   /ebay/search?...          → Browse API item_summary/search (token minted
 *                               and cached here; eBay tokens last 2h)
 *   /justtcg/<path>?...       → api.justtcg.com/v1/<path>   (+ x-api-key)
 *   /ppt/<path>?...           → pokemonpricetracker.com/api/v2/<path> (+ Bearer)
 *   /pricecharting/<path>?... → pricecharting.com/api/<path> (+ t=token)
 *
 * Responses are edge-cached per URL to stretch the free-tier quotas: one
 * cache entry serves every visitor asking about the same card that day.
 */

const ALLOWED_ORIGINS = [
  'https://thesaltykorean.github.io',
  'http://localhost:5173',
  'http://localhost:5199',
]

// Seconds of edge cache per source. Quotas are daily, prices update daily.
const CACHE_TTL = {
  ebay: 6 * 3600,
  justtcg: 12 * 3600,
  ppt: 12 * 3600,
  pricecharting: 12 * 3600,
}

// eBay application tokens last 7200s; cache per isolate with a safety margin.
let ebayToken = { value: null, expiresAt: 0 }

function corsHeaders(request) {
  const origin = request.headers.get('Origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
}

function json(body, status, request, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request), ...extra },
  })
}

async function getEbayToken(env) {
  if (ebayToken.value && ebayToken.expiresAt > Date.now() + 120_000) return ebayToken.value
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body:
      'grant_type=client_credentials&scope=' +
      encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  })
  if (!res.ok) throw new Error(`ebay token ${res.status}`)
  const data = await res.json()
  ebayToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  }
  return ebayToken.value
}

/**
 * Whitelist + clamp the caller's params. Anything not listed is dropped, so
 * unknown params can neither reach upstreams nor bust the cache; limits are
 * clamped because some upstreams bill per returned row (PPT: 1 credit/card).
 */
function sanitizeParams(searchParams, allowed, maxLimits) {
  const params = new URLSearchParams()
  for (const k of allowed) {
    const v = searchParams.get(k)
    if (v) params.set(k, v)
  }
  const max = maxLimits ?? 50
  const limit = Number(params.get('limit'))
  if (params.has('limit') && (!Number.isFinite(limit) || limit < 1 || limit > max)) {
    params.set('limit', String(max))
  }
  params.sort() // stable order → stable cache key
  return params
}

/**
 * Build the upstream request for a given route, or null if unsupported.
 * `cacheParams` is the sanitized, secret-free param set the edge cache is
 * keyed on — never the raw request URL, which callers could vary at will.
 */
async function upstreamFor(source, path, searchParams, env) {
  switch (source) {
    case 'ebay': {
      if (path !== 'search') return null
      if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) return null
      const params = sanitizeParams(searchParams, ['q', 'category_ids', 'limit', 'filter'], 50)
      if (!params.get('q')) return null
      return {
        url: `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
        // Deferred so cache hits don't mint OAuth tokens (and a token-
        // endpoint hiccup can't break requests the cache could serve).
        authorize: async () => ({ Authorization: `Bearer ${await getEbayToken(env)}` }),
        cacheParams: params,
      }
    }
    case 'justtcg': {
      if (!env.JUSTTCG_KEY || !/^(cards|sets|games)$/.test(path)) return null
      // The JA flow lists all sets once (limit=500) to resolve set codes;
      // only card queries are clamped tight.
      const params = sanitizeParams(
        searchParams,
        ['q', 'game', 'set', 'number', 'limit', 'offset'],
        path === 'cards' ? 20 : 500,
      )
      return {
        url: `https://api.justtcg.com/v1/${path}?${params}`,
        headers: { 'x-api-key': env.JUSTTCG_KEY },
        cacheParams: params,
      }
    }
    case 'ppt': {
      if (!env.PPT_KEY || !/^(cards|sets)$/.test(path)) return null
      const params = sanitizeParams(
        searchParams,
        ['search', 'set', 'language', 'limit', 'tcgPlayerId'],
        5,
      )
      if (!params.has('limit')) params.set('limit', '5')
      params.sort()
      return {
        url: `https://www.pokemonpricetracker.com/api/v2/${path}?${params}`,
        headers: { Authorization: `Bearer ${env.PPT_KEY}` },
        cacheParams: params,
      }
    }
    case 'pricecharting': {
      if (!env.PRICECHARTING_KEY || !/^(product|products)$/.test(path)) return null
      const params = sanitizeParams(searchParams, ['q', 'id', 'upc'], 50)
      const upstream = new URLSearchParams(params)
      upstream.set('t', env.PRICECHARTING_KEY)
      return {
        url: `https://www.pricecharting.com/api/${path}?${upstream}`,
        headers: {},
        cacheParams: params, // key excludes the token
      }
    }
    default:
      return null
  }
}

const COLLECTION_KEY = 'collection:v1'
const COLLECTION_MAX_BYTES = 1_000_000

function tokenMatches(request, env) {
  if (!env.SYNC_PASSPHRASE) return false
  const got = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (got.length !== env.SYNC_PASSPHRASE.length) return false
  // Constant-time comparison; string equality would leak timing.
  const enc = new TextEncoder()
  const a = enc.encode(got)
  const b = enc.encode(env.SYNC_PASSPHRASE)
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** GET/PUT the synced collection blob (auth: Bearer SYNC_PASSPHRASE). */
async function handleCollection(request, env) {
  if (!tokenMatches(request, env)) return json({ error: 'unauthorized' }, 401, request)
  if (request.method === 'GET') {
    const blob = await env.COLLECTION.get(COLLECTION_KEY)
    if (blob === null) return json({ updatedAt: null, entries: [] }, 200, request)
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...corsHeaders(request),
      },
    })
  }
  // PUT
  const body = await request.text()
  if (body.length > COLLECTION_MAX_BYTES) return json({ error: 'too large' }, 413, request)
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    return json({ error: 'invalid json' }, 400, request)
  }
  if (typeof parsed?.updatedAt !== 'string' || !Array.isArray(parsed?.entries)) {
    return json({ error: 'expected {updatedAt, entries[]}' }, 400, request)
  }
  // The client's last-write-wins logic is timestamp-based, so a delayed
  // request carrying an older snapshot must not overwrite a newer blob.
  // KV has no compare-and-swap, so this read-then-write can still interleave
  // with a concurrent PUT and let the older body land last without a 409 (a
  // Durable Object would close that window). The system self-heals: the
  // device holding the newer collection keeps its newer local mutatedAt, so
  // its next syncOnOpen sees an older server blob and re-pushes.
  const existing = await env.COLLECTION.get(COLLECTION_KEY)
  if (existing) {
    try {
      const cur = JSON.parse(existing)
      if (typeof cur?.updatedAt === 'string' && cur.updatedAt >= parsed.updatedAt) {
        return json({ error: 'stale write', serverUpdatedAt: cur.updatedAt }, 409, request)
      }
    } catch {
      /* unreadable existing blob: allow overwrite */
    }
  }
  await env.COLLECTION.put(COLLECTION_KEY, body)
  return json({ ok: true, updatedAt: parsed.updatedAt }, 200, request)
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      })
    }

    const url0 = new URL(request.url)
    const isCollection = url0.pathname === '/collection'
    if (request.method !== 'GET' && !(request.method === 'PUT' && isCollection)) {
      return json({ error: 'method not allowed' }, 405, request)
    }
    if (isCollection) {
      const origin0 = request.headers.get('Origin') ?? ''
      if (!ALLOWED_ORIGINS.includes(origin0)) {
        return json({ error: 'origin not allowed' }, 403, request)
      }
      return handleCollection(request, env)
    }

    const url = new URL(request.url)
    const [, source, ...rest] = url.pathname.split('/')
    const path = rest.join('/')

    if (source === '' || source === 'health') {
      return json({ ok: true, sources: {
        ebay: Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET),
        justtcg: Boolean(env.JUSTTCG_KEY),
        ppt: Boolean(env.PPT_KEY),
        pricecharting: Boolean(env.PRICECHARTING_KEY),
      } }, 200, request)
    }

    const ttl = CACHE_TTL[source]
    if (!ttl) return json({ error: 'unknown source' }, 404, request)

    // CORS alone doesn't stop non-browser callers from burning the shared
    // quotas, so source routes require an allowed Origin outright. (Origin
    // is spoofable server-side — this is a tripwire, not a boundary.)
    const origin = request.headers.get('Origin') ?? ''
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return json({ error: 'origin not allowed' }, 403, request)
    }

    let upstream
    try {
      upstream = await upstreamFor(source, path, url.searchParams, env)
    } catch (err) {
      return json({ error: String(err) }, 502, request)
    }
    if (!upstream) return json({ error: 'unsupported path or key not configured' }, 404, request)

    // The cache key is built from the sanitized params (sorted, whitelisted,
    // secret-free) so junk params can't bust it, and every visitor shares
    // one upstream call per distinct real query per TTL.
    const cacheKey = new Request(`${url.origin}/${source}/${path}?${upstream.cacheParams}`, {
      method: 'GET',
    })
    const cache = caches.default
    const cached = await cache.match(cacheKey)
    if (cached) {
      const res = new Response(cached.body, cached)
      for (const [k, v] of Object.entries(corsHeaders(request))) res.headers.set(k, v)
      return res
    }

    let headers = upstream.headers ?? {}
    if (upstream.authorize) {
      try {
        headers = { ...headers, ...(await upstream.authorize()) }
      } catch (err) {
        return json({ error: String(err) }, 502, request)
      }
    }
    const upstreamRes = await fetch(upstream.url, { headers })
    const body = await upstreamRes.text()
    // Freshness only on success: a cached 401/429/5xx would keep prices
    // blank in the browser for the whole TTL after the source recovers.
    const res = new Response(body, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': upstreamRes.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': upstreamRes.ok ? `public, max-age=${ttl}` : 'no-store',
        ...corsHeaders(request),
      },
    })
    if (upstreamRes.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()))
    return res
  },
}
