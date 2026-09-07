/**
 * End-to-end proof for the LLM grading pipeline.
 *
 *   node scripts/verify.mjs
 *
 * Every claim in the README appears here as an assertion. If this exits 0, the
 * portfolio screenshots are backed by something that ran.
 */
const SERVICES = process.env.WF2_SERVICES_URL ?? 'http://localhost:4100'
const N8N = process.env.WF2_N8N_URL ?? 'http://localhost:5678'
const WEBHOOK = `${N8N}/webhook/grade`

let failures = 0
let checks = 0

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const NO_KEEPALIVE = { connection: 'close' }

function check(label, actual, expected) {
  checks++
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ${green('PASS')} ${label}`)
  } else {
    failures++
    console.log(`  ${red('FAIL')} ${label}`)
    console.log(`       expected: ${JSON.stringify(expected)}`)
    console.log(`       actual:   ${JSON.stringify(actual)}`)
  }
}

const post = async (url, body, headers = {}) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...NO_KEEPALIVE, ...headers },
    body: JSON.stringify(body ?? {})
  })
  const text = await res.text()
  let parsed
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

const get = async (url) => {
  const res = await fetch(url, { headers: NO_KEEPALIVE })
  return { status: res.status, body: await res.json() }
}

const stats = () => get(`${SERVICES}/admin/stats`).then((r) => r.body)
const summary = () => get(`${SERVICES}/costs/summary`).then((r) => r.body)
const setChaos = (mode) => post(`${SERVICES}/admin/chaos`, { mode })
const section = (t) => console.log(`\n${t}`)

const ESSAY_A = `Some people believe that university education should be free for
all citizens, while others argue that students ought to bear the cost themselves.
In my view, the state should fund tuition because an educated population produces
benefits that extend well beyond the individual graduate, including higher tax
revenues and lower demand on public services.`.replace(/\s+/g, ' ')

const ESSAY_B = `The rapid growth of remote work has changed how cities function.
Fewer commuters means less pressure on transport networks, but it also hollows out
the businesses that depended on office workers. Governments should therefore treat
the transition as an urban planning problem rather than purely an employment one.`.replace(/\s+/g, ' ')

const submit = (documentId, text) => post(WEBHOOK, { document_id: documentId, text })

async function preflight() {
  try {
    await get(`${SERVICES}/health`)
  } catch {
    console.error(red(`\nMock services unreachable at ${SERVICES}. Run: node mock-services/server.js\n`))
    process.exit(2)
  }
  try {
    const probe = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...NO_KEEPALIVE },
      body: '{}'
    })
    if (probe.status === 404) {
      console.error(red(`\nn8n answers 404 at ${WEBHOOK} - workflow not active or path differs.\n`))
      process.exit(2)
    }
  } catch {
    console.error(red(`\nn8n unreachable at ${N8N}. Run: n8n start\n`))
    process.exit(2)
  }
}

async function main() {
  await preflight()
  await post(`${SERVICES}/admin/reset`)
  await setChaos('healthy')

  // -------------------------------------------------------------------------
  section('1. A new essay is graded and the result validates against the rubric')
  const first = await submit('doc_a', ESSAY_A)
  check('returns 200', first.status, 200)
  check('not served from cache', first.body?.cached, false)
  check('succeeded on the first attempt', first.body?.attempts, 1)
  check('a real cost was recorded', first.body?.cost_usd > 0, true)

  const r = first.body?.result ?? {}
  const bandsValid = ['task_achievement', 'coherence', 'lexical_resource', 'grammar'].every(
    (c) => typeof r[c]?.score === 'number' && r[c].score >= 0 && r[c].score <= 9
  )
  check('all four criteria carry a band in 0-9', bandsValid, true)
  check('one model call was made', (await stats()).model_calls, 1)

  // -------------------------------------------------------------------------
  section('2. Re-grading identical text costs nothing')
  const cached = await submit('doc_a', ESSAY_A)
  check('returns 200', cached.status, 200)
  check('served from cache', cached.body?.cached, true)
  check('cost is zero', cached.body?.cost_usd, 0)
  check('identical result returned', cached.body?.result?.overall, first.body?.result?.overall)
  check('no additional model call', (await stats()).model_calls, 1)

  // -------------------------------------------------------------------------
  section('3. Reformatted but identical text still hits the cache')
  const reformatted = await submit('doc_a', `\n\n  ${ESSAY_A.replace(/ /g, '   ')}  \n`)
  check('served from cache', reformatted.body?.cached, true)
  check('still one model call', (await stats()).model_calls, 1)

  // -------------------------------------------------------------------------
  section('4. A different essay is graded separately')
  const second = await submit('doc_b', ESSAY_B)
  check('returns 200', second.status, 200)
  check('not cached', second.body?.cached, false)
  check('two model calls now', (await stats()).model_calls, 2)

  // -------------------------------------------------------------------------
  section('5. Schema-invalid output is corrected, not passed through')
  await setChaos('malformed_once')
  const corrected = await submit('doc_c', `${ESSAY_A} Additional paragraph for a distinct hash.`)
  check('returns 200', corrected.status, 200)
  check('took two attempts', corrected.body?.attempts, 2)
  check('final result is valid', typeof corrected.body?.result?.overall, 'number')

  const costs = (await get(`${SERVICES}/costs`)).body.filter((c) => c.document_id === 'doc_c')
  check('both attempts were billed', costs.length, 2)
  check(
    'the rejected attempt is recorded as waste',
    costs.filter((c) => c.outcome === 'schema_invalid').length,
    1
  )

  // -------------------------------------------------------------------------
  section('6. Persistently invalid output fails loudly and caches nothing')
  await setChaos('malformed_always')
  const cacheBefore = (await stats()).cached_results
  const failed = await submit('doc_d', `${ESSAY_B} A further distinct paragraph here.`)
  check('returns 502', failed.status, 502)
  check('exhausted all three attempts', failed.body?.attempts, 3)
  check('errors are reported to the caller', Array.isArray(failed.body?.errors), true)
  check('nothing bad was cached', (await stats()).cached_results, cacheBefore)
  check('an alert was raised', (await stats()).alerts, 1)
  check('the wasted spend is visible', (await summary()).wasted_calls >= 4, true)

  // -------------------------------------------------------------------------
  section('7. Rate limiting is waited out, not counted as a failed attempt')
  await setChaos('rate_limit_once')
  const limited = await submit('doc_e', `${ESSAY_A} Yet another distinguishing sentence here.`)
  check('returns 200', limited.status, 200)
  check('still reported as one attempt', limited.body?.attempts, 1)

  // -------------------------------------------------------------------------
  section('8. A truncated response is caught rather than stored')
  await setChaos('truncated')
  const truncated = await submit('doc_f', `${ESSAY_B} One more unique closing sentence.`)
  check('returns 502', truncated.status, 502)
  check('reported as unparseable', /not valid JSON/.test(String(truncated.body?.errors)), true)

  // -------------------------------------------------------------------------
  section('9. Submissions that are too short never reach the model')
  await setChaos('healthy')
  const callsBefore = (await stats()).model_calls
  const short = await submit('doc_g', 'Too short.')
  check('returns 400', short.status, 400)
  check('no model call was made', (await stats()).model_calls, callsBefore)

  // -------------------------------------------------------------------------
  section('Spend report')
  const s = await summary()
  console.log(dim(`       ${s.calls} model calls, $${s.usd_total} total`))
  console.log(dim(`       ${s.wasted_calls} wasted calls, $${s.wasted_usd} burned on rejected output`))
  console.log(dim(`       ${s.cache_hits} cache hits across ${s.runs} runs`))
  console.log(dim(`       $${s.usd_per_document} per document`))
  check('cost per document is measurable', s.usd_per_document > 0, true)

  console.log(
    `\n${failures === 0 ? green('ALL CHECKS PASSED') : red(`${failures} CHECK(S) FAILED`)}  (${checks - failures}/${checks})\n`
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(red(`\nverify.mjs crashed: ${err.message}`))
  if (err.cause) console.error(red(`  cause: ${err.cause.code ?? err.cause}`))
  process.exit(3)
})
