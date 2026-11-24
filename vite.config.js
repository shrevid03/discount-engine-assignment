import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Serves /api/parse-rule during `npm run dev` and `npm run preview` with the same
// handler Vercel runs in production, so the LLM feature works locally.
function parseRuleApi() {
  const middleware = async (req, res, next) => {
    if (req.url !== '/api/parse-rule') return next()
    if (req.method !== 'POST') {
      res.statusCode = 405
      return res.end(JSON.stringify({ error: 'Use POST' }))
    }
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 64_000) break // the handler rejects anything over its limit anyway
    }
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { /* handled as empty */ }
    const { handleParseRuleRequest } = await import('./server/parseRule.js')
    const { status, json, headers } = await handleParseRuleRequest(body, {
      clientId: req.socket?.remoteAddress, bodyBytes: Buffer.byteLength(raw),
    })
    res.statusCode = status
    for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(json))
  }
  return {
    name: 'parse-rule-api',
    configureServer: (server) => { server.middlewares.use(middleware) },
    configurePreviewServer: (server) => { server.middlewares.use(middleware) },
  }
}

export default defineConfig(({ mode }) => {
  // Make GEMINI_API_KEY from .env.local visible to the dev middleware (server side only;
  // it is not prefixed with VITE_ so it is never bundled into the browser code).
  const env = loadEnv(mode, process.cwd(), '')
  for (const key of ['GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FALLBACK_MODEL']) {
    if (env[key] && !process.env[key]) process.env[key] = env[key]
  }
  return { plugins: [react(), parseRuleApi()] }
})
