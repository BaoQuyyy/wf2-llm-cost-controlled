# WF2 — LLM grading with schema validation and cost control

An n8n pipeline that grades IELTS Writing Task 2 essays with an LLM and treats
the model as what it is: an unreliable, metered dependency.

Built from a real problem — marking student writing by hand is slow, and the
naive automation of it is quietly expensive and quietly wrong.

**Three claims, all asserted in `scripts/verify.mjs`: no invalid result ever
reaches a student, no essay is ever paid for twice, and every cent is
attributable to a document.**

![Workflow canvas](docs/screenshots/canvas.png)

The cache branch splits off before the model is ever reached — that upper path
costs nothing. The lower path is the metered one, and it forks again into
"graded" and "not gradable" rather than assuming the model succeeded.

---

## What a plain "call the LLM" node does not do

| | Plain LLM node | This pipeline |
|---|---|---|
| Model returns JSON with band 12.5 | Passed straight to the student | Rejected, corrected, re-requested |
| Model returns truncated JSON | Crashes or stores garbage | Caught, failed loudly, nothing cached |
| Same essay submitted twice | Paid for twice | Second one costs nothing |
| Rubric changes | Serves the old scores forever | Cache key includes rubric version |
| Rate limited | Fails the run | Waited out, not counted as an attempt |
| What did this cost? | Nobody knows | `$/document`, including waste |

---

## Design decisions

### 1. Well-formed JSON is not correct JSON

`response_format: json_object` gets you something that parses. It does not get
you a band between 0 and 9, in half steps, with all four criteria present.
Those are validated explicitly, and a violation never reaches the caller.

### 2. Self-correction beats retrying the same prompt

When validation fails, the specific errors are appended as a follow-up turn:

```
That response was rejected by schema validation:
- task_achievement.score must be between 0 and 9, got 12.5
- grammar is missing
Return corrected JSON only.
```

The model is told what was wrong rather than asked again and hoped at. In the
verified run this recovers on the second attempt.

### 3. Failed calls are billed, so failed calls are metered

**This is the decision that pays for itself.** A rejected response costs exactly
as much as an accepted one. Recording only successes understates real spend by
precisely the amount that most needs watching — a rising `schema_invalid` count
is the earliest signal of prompt or model drift, and it is invisible unless you
write it down.

The ledger separates `usd_total` from `wasted_usd` for that reason.

### 4. The cache key covers content **plus rubric version plus model**

Hashing content alone would keep serving the old scores after a rubric change.
That is not a stale cache, it is a wrong one. Whitespace is collapsed first, so
a reformatted but identical essay still hits.

The key is derived by the cache service, not by the workflow: the cache owns
what identity means, and two callers hashing slightly differently would
silently split the cache in half and double the bill.

### 5. Rate limiting does not consume a correction attempt

A 429 means the model never saw the prompt. Counting it as a failed attempt
would burn one of three correction turns on a message that was never read, so
it is tracked on a separate counter with its own ceiling.

### 6. Failure caches nothing

When all attempts are exhausted the run returns `502` with the validation
errors and the amount spent, raises an alert, and writes nothing to the cache.
A cached failure would be permanent.

---

## Verified

`node scripts/dev.mjs` — **34/34 checks passed** on n8n 2.37.10 / Node 24.

Spend report from that run:

```
11 model calls, $0.001508 total
 7 wasted calls, $0.000831 burned on rejected output
 2 cache hits across 8 runs
$0.000251 per document
```

The waste ratio is high here because the verification deliberately injects
malformed responses — it is not a production figure. The point is that the
number exists at all: without the ledger, that 55% would be invisible, and the
first sign of trouble would be the invoice.

## What `verify.mjs` asserts

1. A new essay grades on the first attempt, all four criteria land in 0–9, and
   a real cost is recorded.
2. Re-submitting identical text is served from cache: zero cost, no extra model
   call, identical result.
3. Reformatted-but-identical text still hits the cache.
4. A different essay is graded separately.
5. With one malformed response injected: two attempts, valid final result, and
   **both** attempts appear in the ledger — one marked `schema_invalid`.
6. With every response malformed: `502`, three attempts, errors returned to the
   caller, nothing cached, an alert raised, and the wasted spend visible.
7. A rate-limited call is waited out and still reported as one attempt.
8. A truncated response is caught as unparseable rather than stored.
9. A too-short submission is rejected before any model call is made.

---

## Running it

Requires Node 22.5+ (`node:sqlite` is built in). No other dependencies.

```bash
node scripts/dev.mjs           # start everything + verify
node scripts/dev.mjs status
node scripts/dev.mjs restart   # after editing the workflow
node scripts/dev.mjs stop
```

### Driving the failure modes by hand

```bash
curl -X POST localhost:4100/admin/chaos -H 'content-type: application/json' -d '{"mode":"malformed_once"}'
curl -X POST localhost:4100/admin/chaos -H 'content-type: application/json' -d '{"mode":"malformed_always"}'
curl -X POST localhost:4100/admin/chaos -H 'content-type: application/json' -d '{"mode":"rate_limit_once"}'
curl -X POST localhost:4100/admin/chaos -H 'content-type: application/json' -d '{"mode":"truncated"}'
curl -X POST localhost:4100/admin/chaos -H 'content-type: application/json' -d '{"mode":"healthy"}'

curl localhost:4100/costs/summary
```

---

## Why the model is mocked

Not for convenience. **A real model cannot be told to return schema-invalid
JSON on demand**, so the self-correction path — the most valuable part of this
pipeline — could never be tested against one. The mock speaks the OpenAI
request/response shape, so pointing it at a real provider changes the URL and
nothing else.

| Demo | Production |
|---|---|
| Mock model with a chaos switch | OpenAI / Anthropic / a local model |
| SQLite via `node:sqlite` | Postgres — same tables, same queries |
| `POST /alerts` sink | Slack incoming webhook |
| Hard-coded price table | The provider's published pricing |

## A note on the n8n Code sandbox

Neither `require('crypto')` nor `globalThis.crypto` is available inside a Code
node — the first is blocked outright, the second is simply not in the sandbox.
Hashing therefore happens in the service. That turned out to be the better
design anyway (see decision 4), but it is worth knowing before planning a
workflow that assumes otherwise.
