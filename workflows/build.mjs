/**
 * Builds the WF2 workflow JSON from source.
 *
 *   node workflows/build.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICES_URL = process.env.WF2_SERVICES_URL ?? 'http://localhost:4100'
const RUBRIC_VERSION = 'ielts-writing-task2-v1'
const MODEL = 'mock-grader-v1'

let idCounter = 0
const nid = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${++idCounter}`

const node = (name, type, typeVersion, parameters, position, extra = {}) => ({
  parameters,
  id: nid(name),
  name,
  type,
  typeVersion,
  position,
  ...extra
})

const code = (name, jsCode, position) =>
  node(name, 'n8n-nodes-base.code', 2, { jsCode }, position)

const respond = (name, statusCode, body, position) =>
  node(
    name,
    'n8n-nodes-base.respondToWebhook',
    1.1,
    {
      respondWith: 'json',
      responseBody: body,
      options: { responseCode: statusCode }
    },
    position
  )

const ifTrue = (name, expression, position) =>
  node(
    name,
    'n8n-nodes-base.if',
    2.2,
    {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: nid('cond'),
            leftValue: expression,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true }
          }
        ],
        combinator: 'and'
      },
      options: {}
    },
    position
  )

const postJson = (name, path, bodyExpression, position) =>
  node(
    name,
    'n8n-nodes-base.httpRequest',
    4.2,
    {
      method: 'POST',
      url: `${SERVICES_URL}${path}`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: bodyExpression,
      options: {}
    },
    position
  )

const connect = (c, from, to, outputIndex = 0) => {
  c[from] ??= { main: [] }
  while (c[from].main.length <= outputIndex) c[from].main.push([])
  c[from].main[outputIndex].push({ node: to, type: 'main', index: 0 })
}

// ---------------------------------------------------------------------------

const NORMALISE_JS = `
// ---------------------------------------------------------------------------
// Normalise and validate the submission.
//
// Whitespace is collapsed here so a reformatted-but-identical essay still
// hits the cache. The cache KEY itself is derived by the cache service rather
// than here: it owns the cache, so it decides what identity means, and two
// callers hashing slightly differently would silently split the cache and
// double the bill.
//
// (n8n's Code sandbox also blocks both require('crypto') and globalThis
// .crypto, so hashing in a Code node is not available anyway without setting
// NODE_FUNCTION_ALLOW_BUILTIN on the server - which this workflow avoids
// needing, so it runs on an instance you do not control.)
// ---------------------------------------------------------------------------
const raw = $input.first().json;
const body = raw.body ?? raw;

const text = typeof body.text === 'string' ? body.text.replace(/\\s+/g, ' ').trim() : '';
const errors = [];

if (typeof body.document_id !== 'string' || body.document_id.trim() === '') {
  errors.push('document_id must be a non-empty string');
}
if (text.length < 50) {
  errors.push('text must be at least 50 characters of prose');
}
if (text.length > 20000) {
  errors.push('text exceeds the 20000 character limit for a single submission');
}

return [{
  json: {
    valid: errors.length === 0,
    errors,
    document_id: body.document_id ?? null,
    text,
    word_count: text ? text.split(' ').length : 0,
    rubric_version: ${JSON.stringify(RUBRIC_VERSION)},
    model: ${JSON.stringify(MODEL)}
  }
}];
`.trim()

const GRADE_JS = `
// ---------------------------------------------------------------------------
// Call the model, validate its output against the rubric schema, and correct
// it in place when it comes back wrong.
//
// Three things here that a plain "call the LLM" node does not do:
//
//   1. VALIDATE. A model returning well-formed JSON is not the same as a model
//      returning CORRECT JSON. Bands outside 0-9, or a missing criterion, are
//      caught here rather than reaching the student's report.
//
//   2. SELF-CORRECT. On a schema violation the errors are fed back to the model
//      as a follow-up turn. It is told exactly what was wrong, which is far
//      more effective than retrying an identical prompt and hoping.
//
//   3. METER EVERY CALL, INCLUDING THE FAILED ONES. A rejected response still
//      costs money. Recording only successful calls understates real spend by
//      exactly the amount that most needs watching, because a rising
//      schema_invalid count is the early signal of prompt or model drift.
// ---------------------------------------------------------------------------
const SERVICES_URL = ${JSON.stringify(SERVICES_URL)};
const LLM_URL = SERVICES_URL + '/v1/chat/completions';
const MAX_ATTEMPTS = 3;
const MAX_RATE_LIMIT_WAITS = 4;
const CRITERIA = ['task_achievement', 'coherence', 'lexical_resource', 'grammar'];

const input = $('Normalise submission').first().json;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns [] when the payload satisfies the rubric contract. */
function schemaErrors(obj) {
  const errs = [];
  if (typeof obj !== 'object' || obj === null) return ['response is not an object'];

  for (const c of CRITERIA) {
    const band = obj[c];
    if (!band || typeof band !== 'object') { errs.push(c + ' is missing'); continue; }
    if (typeof band.score !== 'number' || Number.isNaN(band.score)) {
      errs.push(c + '.score must be a number');
    } else if (band.score < 0 || band.score > 9) {
      errs.push(c + '.score must be between 0 and 9, got ' + band.score);
    } else if (Math.round(band.score * 2) !== band.score * 2) {
      errs.push(c + '.score must be a whole or half band, got ' + band.score);
    }
    if (typeof band.evidence !== 'string' || band.evidence.trim() === '') {
      errs.push(c + '.evidence must be a non-empty string');
    }
  }

  if (typeof obj.overall !== 'number' || obj.overall < 0 || obj.overall > 9) {
    errs.push('overall must be a number between 0 and 9');
  }
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') {
    errs.push('summary must be a non-empty string');
  }
  return errs;
}

const systemPrompt =
  'You are an IELTS Writing Task 2 examiner. Return ONLY JSON matching: ' +
  '{ task_achievement:{score:number 0-9 in half bands, evidence:string}, ' +
  'coherence:{...}, lexical_resource:{...}, grammar:{...}, ' +
  'overall:number, summary:string }';

const messages = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: input.text }
];

let attempts = 0;
let usdTotal = 0;
let lastErrors = null;
let rateLimitWaits = 0;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  attempts = attempt;

  let res;
  try {
    res = await this.helpers.httpRequest({
      method: 'POST',
      url: LLM_URL,
      body: { model: input.model, messages, response_format: { type: 'json_object' } },
      json: true,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true
    });
  } catch (err) {
    lastErrors = ['transport: ' + err.message];
    if (attempt < MAX_ATTEMPTS) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
    break;
  }

  // Rate limiting is not the model's fault and not a schema problem - back off
  // and retry the same prompt, without burning one of the correction turns on
  // a message the model never saw.
  if (res.statusCode === 429) {
    rateLimitWaits++;
    if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
      lastErrors = ['rate limited ' + rateLimitWaits + ' times; giving up'];
      break;
    }
    const retryAfter = Number(res.headers?.['retry-after']);
    await sleep((Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1) * 1000);
    // Does not consume a correction turn: the model never saw this prompt, so
    // re-sending it is a retry, not a second attempt at getting the schema
    // right. The separate counter is what keeps that from looping forever.
    attempt--;
    continue;
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    lastErrors = ['HTTP ' + res.statusCode + ': ' + JSON.stringify(res.body)];
    if (attempt < MAX_ATTEMPTS) { await sleep(1000 * Math.pow(2, attempt - 1)); continue; }
    break;
  }

  const usage = res.body?.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const content = res.body?.choices?.[0]?.message?.content ?? '';

  let parsed = null;
  let errs;
  try {
    parsed = JSON.parse(content);
    errs = schemaErrors(parsed);
  } catch (err) {
    // A truncated response fails here. It is charged for all the same.
    errs = ['response was not valid JSON: ' + err.message];
  }

  const cost = await this.helpers.httpRequest({
    method: 'POST',
    url: SERVICES_URL + '/costs',
    body: {
      document_id: input.document_id,
      model: input.model,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      attempt,
      outcome: errs.length === 0 ? 'valid' : 'schema_invalid'
    },
    json: true
  });
  usdTotal += cost?.usd ?? 0;

  if (errs.length === 0) {
    return [{
      json: {
        graded: true,
        attempts,
        usd: Number(usdTotal.toFixed(8)),
        cache_key: $('Cache lookup').first().json.cache_key,
        document_id: input.document_id,
        model: input.model,
        rubric_version: input.rubric_version,
        result: parsed
      }
    }];
  }

  lastErrors = errs;

  // Feed the failure back so the next turn is a correction, not a repeat.
  if (attempt < MAX_ATTEMPTS) {
    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content:
        'That response was rejected by schema validation:\\n- ' +
        errs.join('\\n- ') +
        '\\nReturn corrected JSON only.'
    });
  }
}

return [{
  json: {
    graded: false,
    attempts,
    usd: Number(usdTotal.toFixed(8)),
    cache_key: $('Cache lookup').first().json.cache_key,
    document_id: input.document_id,
    model: input.model,
    rubric_version: input.rubric_version,
    errors: lastErrors
  }
}];
`.trim()

function buildWorkflow() {
  const nodes = [
    node(
      'Webhook: essay submitted',
      'n8n-nodes-base.webhook',
      2,
      { httpMethod: 'POST', path: 'grade', responseMode: 'responseNode', options: {} },
      [-760, 300],
      { webhookId: 'wf2-grade-webhook' }
    ),

    code('Normalise submission', NORMALISE_JS, [-540, 300]),

    ifTrue('Valid submission?', '={{ $json.valid }}', [-320, 300]),

    respond(
      'Respond 400: invalid submission',
      400,
      '={{ JSON.stringify({ error: "validation_failed", details: $json.errors }) }}',
      [-100, 460]
    ),

    postJson(
      'Cache lookup',
      '/cache/lookup',
      '={{ JSON.stringify({ text: $json.text, rubric_version: $json.rubric_version, model: $json.model }) }}',
      [-100, 140]
    ),

    ifTrue('Cache hit?', '={{ $json.hit }}', [120, 140]),

    postJson(
      'Record run: cache hit',
      '/runs',
      `={{ JSON.stringify({ document_id: $('Normalise submission').item.json.document_id, cache_key: $('Cache lookup').item.json.cache_key, outcome: "cache_hit", attempts: 0, cache_hit: true, usd: 0, detail: "served from cache; no model call" }) }}`,
      [340, 20]
    ),

    respond(
      'Respond 200: cached',
      200,
      `={{ JSON.stringify({ status: "graded", cached: true, cost_usd: 0, document_id: $('Normalise submission').item.json.document_id, result: $('Cache lookup').item.json.result }) }}`,
      [560, 20]
    ),

    code('Grade with self-correction', GRADE_JS, [340, 280]),

    ifTrue('Graded?', '={{ $json.graded }}', [560, 280]),

    postJson(
      'Store in cache',
      '/cache',
      '={{ JSON.stringify({ cache_key: $json.cache_key, document_id: $json.document_id, model: $json.model, rubric_version: $json.rubric_version, result: $json.result }) }}',
      [780, 180]
    ),

    postJson(
      'Record run: graded',
      '/runs',
      `={{ JSON.stringify({ document_id: $('Grade with self-correction').item.json.document_id, cache_key: $('Grade with self-correction').item.json.cache_key, outcome: "graded", attempts: $('Grade with self-correction').item.json.attempts, cache_hit: false, usd: $('Grade with self-correction').item.json.usd, detail: "attempts=" + $('Grade with self-correction').item.json.attempts }) }}`,
      [1000, 180]
    ),

    respond(
      'Respond 200: graded',
      200,
      `={{ JSON.stringify({ status: "graded", cached: false, attempts: $('Grade with self-correction').item.json.attempts, cost_usd: $('Grade with self-correction').item.json.usd, document_id: $('Grade with self-correction').item.json.document_id, result: $('Grade with self-correction').item.json.result }) }}`,
      [1220, 180]
    ),

    postJson(
      'Alert: grading failed',
      '/alerts',
      `={{ JSON.stringify({ severity: "error", text: "Grading failed after " + $json.attempts + " attempts for " + $json.document_id + ". Spent $" + $json.usd + " with no usable result. Errors: " + JSON.stringify($json.errors) }) }}`,
      [780, 400]
    ),

    postJson(
      'Record run: failed',
      '/runs',
      `={{ JSON.stringify({ document_id: $('Grade with self-correction').item.json.document_id, cache_key: $('Grade with self-correction').item.json.cache_key, outcome: "failed", attempts: $('Grade with self-correction').item.json.attempts, cache_hit: false, usd: $('Grade with self-correction').item.json.usd, detail: JSON.stringify($('Grade with self-correction').item.json.errors) }) }}`,
      [1000, 400]
    ),

    respond(
      'Respond 502: not gradable',
      502,
      `={{ JSON.stringify({ status: "grading_failed", attempts: $('Grade with self-correction').item.json.attempts, cost_usd: $('Grade with self-correction').item.json.usd, errors: $('Grade with self-correction').item.json.errors, note: "nothing was cached; the document can be resubmitted" }) }}`,
      [1220, 400]
    )
  ]

  const c = {}
  connect(c, 'Webhook: essay submitted', 'Normalise submission')
  connect(c, 'Normalise submission', 'Valid submission?')
  connect(c, 'Valid submission?', 'Cache lookup', 0)
  connect(c, 'Valid submission?', 'Respond 400: invalid submission', 1)
  connect(c, 'Cache lookup', 'Cache hit?')
  connect(c, 'Cache hit?', 'Record run: cache hit', 0)
  connect(c, 'Cache hit?', 'Grade with self-correction', 1)
  connect(c, 'Record run: cache hit', 'Respond 200: cached')
  connect(c, 'Grade with self-correction', 'Graded?')
  connect(c, 'Graded?', 'Store in cache', 0)
  connect(c, 'Graded?', 'Alert: grading failed', 1)
  connect(c, 'Store in cache', 'Record run: graded')
  connect(c, 'Record run: graded', 'Respond 200: graded')
  connect(c, 'Alert: grading failed', 'Record run: failed')
  connect(c, 'Record run: failed', 'Respond 502: not gradable')

  return {
    id: 'wf2LlmCostCtrl0',
    name: 'WF2 - LLM grading with schema validation and cost control',
    active: false,
    // Without triggerCount the imported workflow activates but never binds its
    // webhook. See trap #2 in
    // https://github.com/BaoQuyyy/wf1-resilient-ingest/blob/main/docs/NOTES.md
    triggerCount: 1,
    nodes,
    connections: c,
    settings: { executionOrder: 'v1' },
    pinData: {}
  }
}

mkdirSync(HERE, { recursive: true })
const wf = buildWorkflow()
writeFileSync(join(HERE, '01-llm-grading.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8')
console.log(`wrote 01-llm-grading.json (${wf.nodes.length} nodes)`)
