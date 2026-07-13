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

/** Build the upstream request for a given route, or null if unsupported. */
async function upstreamFor(source, path, searchParams, env) {
  switch (source) {
    case 'ebay': {
      if (path !== 'search') return null
      if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) return null
      const params = new URLSearchParams()
      for (const k of ['q', 'category_ids', 'limit', 'filter']) {
        const v = searchParams.get(k)
        if (v) params.set(k, v)
      }
      if (!params.get('q')) return null
      return {
        url: `https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`,
        headers: { Authorization: `Bearer ${await getEbayToken(env)}` },
      }
    }
    case 'justtcg': {
      if (!env.JUSTTCG_KEY || !/^(cards|sets|games)$/.test(path)) return null
      return {
        url: `https://api.justtcg.com/v1/${path}?${searchParams}`,
        headers: { 'x-api-key': env.JUSTTCG_KEY },
      }
    }
    case 'ppt': {
      if (!env.PPT_KEY || !/^(cards|sets)$/.test(path)) return null
      return {
        url: `https://www.pokemonpricetracker.com/api/v2/${path}?${searchParams}`,
        headers: { Authorization: `Bearer ${env.PPT_KEY}` },
      }
    }
    case 'pricecharting': {
      if (!env.PRICECHARTING_KEY || !/^(product|products)$/.test(path)) return null
      const params = new URLSearchParams(searchParams)
      params.set('t', env.PRICECHARTING_KEY)
      return { url: `https://www.pricecharting.com/api/${path}?${params}`, headers: {} }
    }
    default:
      return null
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405, request)
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

    // Serve from the edge cache first — the cache key ignores the Origin so
    // every visitor shares one upstream call per distinct query per TTL.
    const cacheKey = new Request(url.toString(), { method: 'GET' })
    const cache = caches.default
    const cached = await cache.match(cacheKey)
    if (cached) {
      const res = new Response(cached.body, cached)
      for (const [k, v] of Object.entries(corsHeaders(request))) res.headers.set(k, v)
      return res
    }

    let upstream
    try {
      upstream = await upstreamFor(source, path, url.searchParams, env)
    } catch (err) {
      return json({ error: String(err) }, 502, request)
    }
    if (!upstream) return json({ error: 'unsupported path or key not configured' }, 404, request)

    const upstreamRes = await fetch(upstream.url, { headers: upstream.headers })
    const body = await upstreamRes.text()
    const res = new Response(body, {
      status: upstreamRes.status,
      headers: {
        'Content-Type': upstreamRes.headers.get('Content-Type') ?? 'application/json',
        'Cache-Control': `public, max-age=${ttl}`,
        ...corsHeaders(request),
      },
    })
    if (upstreamRes.ok) ctx.waitUntil(cache.put(cacheKey, res.clone()))
    return res
  },
}
