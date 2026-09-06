import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.WF2_DB_PATH ?? join(HERE, 'data', 'grading.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
  -- Results keyed by a hash of (content + rubric version + model). Re-grading
  -- the same essay must never cost money twice, and the key has to include
  -- the rubric and model: a rubric change genuinely invalidates the result,
  -- so hashing content alone would serve stale scores forever.
  CREATE TABLE IF NOT EXISTS result_cache (
    cache_key     TEXT PRIMARY KEY,
    document_id   TEXT NOT NULL,
    model         TEXT NOT NULL,
    rubric_version TEXT NOT NULL,
    result_json   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    hit_count     INTEGER NOT NULL DEFAULT 0
  );

  -- One row per real model call. Cache hits deliberately do NOT appear here:
  -- this table answers "what did we actually pay", and a hit paid nothing.
  CREATE TABLE IF NOT EXISTS cost_ledger (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                TEXT NOT NULL,
    document_id       TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    usd               REAL NOT NULL,
    attempt           INTEGER NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN ('valid','schema_invalid','error'))
  );
  CREATE INDEX IF NOT EXISTS idx_cost_doc ON cost_ledger(document_id);

  CREATE TABLE IF NOT EXISTS runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    document_id   TEXT NOT NULL,
    cache_key     TEXT NOT NULL,
    outcome       TEXT NOT NULL,
    attempts      INTEGER NOT NULL,
    cache_hit     INTEGER NOT NULL,
    usd           REAL NOT NULL,
    detail        TEXT
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    severity TEXT NOT NULL,
    text     TEXT NOT NULL
  );
`)

const now = () => new Date().toISOString()

export function getCached(cacheKey) {
  const row = db.prepare('SELECT * FROM result_cache WHERE cache_key = ?').get(cacheKey)
  if (!row) return { hit: false }
  db.prepare('UPDATE result_cache SET hit_count = hit_count + 1 WHERE cache_key = ?').run(cacheKey)
  return { hit: true, result: JSON.parse(row.result_json), hit_count: row.hit_count + 1 }
}

export function putCached({ cacheKey, documentId, model, rubricVersion, result }) {
  db.prepare(
    `INSERT OR REPLACE INTO result_cache
       (cache_key, document_id, model, rubric_version, result_json, created_at, hit_count)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT hit_count FROM result_cache WHERE cache_key = ?), 0))`
  ).run(cacheKey, documentId, model, rubricVersion, JSON.stringify(result), now(), cacheKey)
  return { ok: true }
}

export function recordCost({
  documentId,
  model,
  promptTokens,
  completionTokens,
  usd,
  attempt,
  outcome
}) {
  db.prepare(
    `INSERT INTO cost_ledger
       (ts, document_id, model, prompt_tokens, completion_tokens, usd, attempt, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(now(), documentId, model, promptTokens, completionTokens, usd, attempt, outcome)
  return { ok: true }
}

export function recordRun({ documentId, cacheKey, outcome, attempts, cacheHit, usd, detail }) {
  db.prepare(
    `INSERT INTO runs (ts, document_id, cache_key, outcome, attempts, cache_hit, usd, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(now(), documentId, cacheKey, outcome, attempts, cacheHit ? 1 : 0, usd, detail ?? null)
  return { ok: true }
}

export function costSummary() {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(usd), 0) AS usd_total,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens
       FROM cost_ledger`
    )
    .get()

  // Cost wasted on responses that failed schema validation. If this number is
  // not small, the prompt or the schema is wrong - and without measuring it,
  // nobody would ever notice.
  const wasted = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(usd), 0) AS usd
       FROM cost_ledger WHERE outcome != 'valid'`
    )
    .get()

  const runs = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(cache_hit), 0) AS cache_hits
       FROM runs`
    )
    .get()

  const gradedDocs = db.prepare('SELECT COUNT(DISTINCT document_id) AS n FROM cost_ledger').get().n

  return {
    calls: totals.calls,
    usd_total: Number(totals.usd_total.toFixed(6)),
    prompt_tokens: totals.prompt_tokens,
    completion_tokens: totals.completion_tokens,
    wasted_calls: wasted.calls,
    wasted_usd: Number(wasted.usd.toFixed(6)),
    runs: runs.runs,
    cache_hits: runs.cache_hits,
    usd_per_document: gradedDocs
      ? Number((totals.usd_total / gradedDocs).toFixed(6))
      : 0
  }
}

export function listCosts() {
  return db.prepare('SELECT * FROM cost_ledger ORDER BY id').all()
}

export function listRuns() {
  return db.prepare('SELECT * FROM runs ORDER BY id').all()
}

export function insertAlert({ severity, text }) {
  db.prepare('INSERT INTO alerts (ts, severity, text) VALUES (?, ?, ?)').run(now(), severity, text)
}

export function listAlerts() {
  return db.prepare('SELECT * FROM alerts ORDER BY id').all()
}

export function resetAll() {
  for (const t of ['result_cache', 'cost_ledger', 'runs', 'alerts']) db.exec(`DELETE FROM ${t}`)
}

export function stats() {
  const one = (sql) => db.prepare(sql).get().n
  return {
    cached_results: one('SELECT COUNT(*) n FROM result_cache'),
    model_calls: one('SELECT COUNT(*) n FROM cost_ledger'),
    runs: one('SELECT COUNT(*) n FROM runs'),
    cache_hits: one('SELECT COALESCE(SUM(cache_hit),0) n FROM runs'),
    alerts: one('SELECT COUNT(*) n FROM alerts'),
    usd_total: Number(
      db.prepare('SELECT COALESCE(SUM(usd),0) v FROM cost_ledger').get().v.toFixed(6)
    )
  }
}
