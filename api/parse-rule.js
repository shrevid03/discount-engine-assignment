// Vercel serverless function: POST /api/parse-rule { text, context } → { draft } | { error }
import { handleParseRuleRequest } from '../server/parseRule.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Use POST' })
  }
  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { body = {} }
  }
  const clientId = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim()
  const bodyBytes = Number(req.headers['content-length'] ?? 0)
  const { status, json, headers } = await handleParseRuleRequest(body, { clientId, bodyBytes })
  for (const [k, v] of Object.entries(headers ?? {})) res.setHeader(k, v)
  res.status(status).json(json)
}
