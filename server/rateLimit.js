/**
 * rateLimit.js — a small in-memory limiter for the public /api/parse-rule endpoint.
 *
 * The endpoint is public, so anyone could call it in a loop and use up the
 * Gemini free-tier quota before a reviewer opens the app. This caps each client
 * and the instance as a whole.
 *
 * Limitation, on purpose: memory is per serverless instance, so the limits are
 * per instance, not global. That's enough to stop one script hammering the
 * endpoint. A production version would keep the counters in a shared store
 * (Redis/Upstash) or use the host's firewall rate limiting.
 */

export function createRateLimiter({ perClient = 8, global = 60, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map() // key -> timestamps inside the window
  const recent = (key) => {
    const cutoff = now() - windowMs
    const list = (hits.get(key) ?? []).filter((t) => t > cutoff)
    hits.set(key, list)
    return list
  }
  return function check(clientId = 'unknown') {
    const mine = recent(`c:${clientId}`)
    const all = recent('global')
    if (mine.length >= perClient || all.length >= global) {
      const oldest = Math.min(...(mine.length >= perClient ? mine : all))
      return { ok: false, retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000)) }
    }
    mine.push(now())
    all.push(now())
    if (hits.size > 5000) hits.clear() // don't grow without bound under many client ids
    return { ok: true }
  }
}
