/**
 * Stand-ins for the LLM grading pipeline.
 *
 *   /v1/chat/completions   an OpenAI-shaped model endpoint that can be told to
 *                          return malformed output, rate-limit, or truncate.
 *   /cache/*  /costs/*     the pipeline's own state: result cache and the cost
 *                          ledger that makes spend per document visible.
 *   /alerts                stand-in for Slack.
 *
 * The model is mocked ON PURPOSE rather than for convenience: a real model
 * cannot be made to return schema-invalid JSON on demand, so the
 * self-correction path could never be tested against one. Point WF2_LLM_URL at
 * a real provider to run the same pipeline for real - the request shape is
 * unchanged.
 *
 * Zero dependencies: node:http + node:sqlite + node:crypto.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import * as store from './db.js'

const PORT = Number(process.env.PORT ?? 4100)

// Priced per million tokens, matching the shape of published provider pricing.
const PRICING = {
  'mock-grader-v1': { inputPerM: 0.25, outputPerM: 1.25 }
}

const chaos = {
  mode: 'healthy', // healthy | malformed_once | malformed_always | rate_limit_once | truncated
  callsSeen: 0
}

const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers
  })
  res.end(payload)
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 5_000_000) {
        reject(new Error('payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })

// ---------------------------------------------------------------------------
// Deterministic "grading". Same essay always produces the same scores, which
// is what makes the cache assertion meaningful: a cache hit must return
// exactly what the first call returned.
// ---------------------------------------------------------------------------
const CRITERIA = ['task_achievement', 'coherence', 'lexical_resource', 'grammar']

function gradeDeterministically(text) {
  const digest = createHash('sha256').update(text).digest()
  const result = {}
  CRITERIA.forEach((c, i) => {
    // Bands 4.0 - 8.5 in half steps, derived from the digest.
    const band = 4 + (digest[i] % 10) / 2
    result[c] = {
      score: Number(band.toFixed(1)),
      evidence: `Derived from ${text.trim().split(/\s+/).length} words of submitted text.`
    }
  })
  const overall =
    CRITERIA.reduce((sum, c) => sum + result[c].score, 0) / CRITERIA.length
  result.overall = Number((Math.round(overall * 2) / 2).toFixed(1))
  result.summary = `Overall band ${result.overall}. Strongest: ${
    CRITERIA.reduce((a, b) => (result[a].score >= result[b].score ? a : b))
  }.`
  return result
}

/** A response that parses as JSON but violates the schema. */
function malformedGrade(text) {
  const good = gradeDeterministically(text)
  return {
    ...good,
    // Out of range, and grammar is missing entirely.
    task_achievement: { score: 12.5, evidence: 'nonsense band' },
    grammar: undefined
  }
}

const countTokens = (s) => Math.max(1, Math.ceil(String(s).length / 4))

// ---------------------------------------------------------------------------

const routes = {
  'POST /v1/chat/completions': (req, res, body) => {
    chaos.callsSeen++
    const model = body?.model ?? 'mock-grader-v1'
    const messages = body?.messages ?? []
    const userText = messages.map((m) => m.content ?? '').join('\n')

    if (chaos.mode === 'rate_limit_once' && chaos.callsSeen === 1) {
      return json(
        res,
        429,
        { error: { type: 'rate_limit_error', message: 'slow down' } },
        { 'retry-after': '1' }
      )
    }

    const promptTokens = countTokens(userText)

    if (chaos.mode === 'truncated') {
      const partial = JSON.stringify(gradeDeterministically(userText)).slice(0, 60)
      return json(res, 200, {
        model,
        choices: [{ message: { content: partial }, finish_reason: 'length' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 20 }
      })
    }

    const wantsMalformed =
      chaos.mode === 'malformed_always' ||
      (chaos.mode === 'malformed_once' && chaos.callsSeen === 1)

    const grade = wantsMalformed
      ? malformedGrade(userText)
      : gradeDeterministically(userText)

    const content = JSON.stringify(grade)
    return json(res, 200, {
      model,
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: countTokens(content)
      }
    })
  },

  'GET /admin/chaos': (req, res) => json(res, 200, chaos),

  'POST /admin/chaos': (req, res, body) => {
    const modes = ['healthy', 'malformed_once', 'malformed_always', 'rate_limit_once', 'truncated']
    if (body?.mode && !modes.includes(body.mode)) {
      return json(res, 400, { error: `mode must be one of ${modes.join(', ')}` })
    }
    chaos.mode = body?.mode ?? chaos.mode
    // Reset the counter so "once" modes are repeatable across test sections.
    chaos.callsSeen = 0
    return json(res, 200, chaos)
  },

  'GET /pricing': (req, res) => json(res, 200, PRICING),

  // The cache owner derives the key, rather than each caller doing it and
  // hoping everyone agrees. Two callers hashing slightly differently would
  // silently split the cache in half and double the bill.
  //
  // The key covers content + rubric version + model: hashing content alone
  // would keep serving old scores after a rubric change, which is worse than
  // a stale cache - it is a wrong one.
  'POST /cache/lookup': (req, res, body) => {
    if (typeof body?.text !== 'string') return json(res, 400, { error: 'text is required' })
    const rubricVersion = body.rubric_version ?? 'unknown'
    const model = body.model ?? 'unknown'
    const cacheKey = createHash('sha256')
      .update(`${body.text}|${rubricVersion}|${model}`)
      .digest('hex')
    return json(res, 200, { ...store.getCached(cacheKey), cache_key: cacheKey })
  },

  'POST /cache': (req, res, body) => {
    if (!body?.cache_key || !body?.result) {
      return json(res, 400, { error: 'cache_key and result are required' })
    }
    return json(
      res,
      201,
      store.putCached({
        cacheKey: body.cache_key,
        documentId: body.document_id ?? 'unknown',
        model: body.model ?? 'unknown',
        rubricVersion: body.rubric_version ?? 'unknown',
        result: body.result
      })
    )
  },

  'POST /costs': (req, res, body) => {
    const required = ['document_id', 'model', 'prompt_tokens', 'completion_tokens', 'attempt', 'outcome']
    for (const f of required) {
      if (body?.[f] === undefined) return json(res, 400, { error: `${f} is required` })
    }
    const price = PRICING[body.model] ?? PRICING['mock-grader-v1']
    const usd =
      (body.prompt_tokens / 1_000_000) * price.inputPerM +
      (body.completion_tokens / 1_000_000) * price.outputPerM

    store.recordCost({
      documentId: body.document_id,
      model: body.model,
      promptTokens: body.prompt_tokens,
      completionTokens: body.completion_tokens,
      usd,
      attempt: body.attempt,
      outcome: body.outcome
    })
    return json(res, 201, { usd: Number(usd.toFixed(8)) })
  },

  'GET /costs': (req, res) => json(res, 200, store.listCosts()),
  'GET /costs/summary': (req, res) => json(res, 200, store.costSummary()),

  'POST /runs': (req, res, body) => {
    store.recordRun({
      documentId: body?.document_id ?? 'unknown',
      cacheKey: body?.cache_key ?? '',
      outcome: body?.outcome ?? 'unknown',
      attempts: body?.attempts ?? 0,
      cacheHit: body?.cache_hit === true,
      usd: body?.usd ?? 0,
      detail: typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? null)
    })
    return json(res, 201, { ok: true })
  },

  'GET /runs': (req, res) => json(res, 200, store.listRuns()),

  'POST /alerts': (req, res, body) => {
    store.insertAlert({ severity: body?.severity ?? 'warning', text: body?.text ?? '(no text)' })
    return json(res, 201, { ok: true })
  },

  'GET /alerts': (req, res) => json(res, 200, store.listAlerts()),

  'POST /admin/reset': (req, res) => {
    store.resetAll()
    chaos.mode = 'healthy'
    chaos.callsSeen = 0
    return json(res, 200, { ok: true, stats: store.stats() })
  },

  'GET /admin/stats': (req, res) => json(res, 200, store.stats()),
  'GET /health': (req, res) => json(res, 200, { ok: true })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const key = `${req.method} ${url.pathname}`
  try {
    const handler = routes[key]
    if (!handler) return json(res, 404, { error: 'not_found', path: key })
    const body = req.method === 'POST' ? await readBody(req) : undefined
    return await handler(req, res, body, url)
  } catch (err) {
    console.error(`[error] ${key}:`, err.message)
    return json(res, 400, { error: 'bad_request', message: err.message })
  }
})

server.listen(PORT, () => {
  console.log(`wf2 mock services listening on http://localhost:${PORT}`)
  console.log(`  model chaos:  POST /admin/chaos {"mode":"malformed_once"}`)
  console.log(`  spend:        GET  /costs/summary`)
})
