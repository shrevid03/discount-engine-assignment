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
  const { status, json } = await handleParseRuleRequest(body)
  res.status(status).json(json)
}
