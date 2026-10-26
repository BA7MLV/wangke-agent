# Bot hardening implementation record

## Integration baseline

Integrated `main@221d397b7cf9ed7362a73999e70a6fcce151af22` into
`feat/im-study-gateway`; no changes to the original checkout or its data.
MCP HTTP/SSE/stdio, OAuth, resources/prompts and scope controls are retained.

### Database upgrade

Back up the SQLite database (including WAL using SQLite's backup API) before
upgrading. Startup recognizes v12, MCP v13, Gateway v13 and Gateway v14 by
complete trusted table/column layouts, not just the shared version number.
The missing branch is installed transactionally and converges to v15.
Credentials, owner IDs, runs, approvals, queues and cursors are never rewritten.
Partial/unrecognized layouts fail closed. Restore a consistent backup rather
than editing `schema_migrations` or manually renumbering versions.

Verification on macOS Node 26.3.0:

- `npx tsx scripts/test-bot-migrations.mjs`: five upgrade layouts and repeated
  startup pass; partial schema rejected.
- `npm run build:api`, `test:api`, `test:bot`, `test:cloud`, `test:gateway`,
  `test:mcp`: pass, including fake MCP transport and IM-to-Bot execution.

No real IM account or paid model was contacted. Linux/Docker and real-model
quality acceptance are separate from deterministic software tests.

## Runtime/tool foundation

Scheduler failures have a rejection boundary and bounded 1–30 second retry
delay, including when error persistence is unavailable. Recovery excludes
currently active runs. Close prevents further scheduling. Interrupted side
effects are reported rather than replayed.

Tool schemas use a bounded draft-07 validator: no coercion, extra built-in
arguments, remote references, regex or silently ignored unknown keywords.
Unsupported MCP schemas are visibly unavailable, not treated as unrestricted.
MCP's own current owner/revision/enabled/scope checks remain authoritative.
Learning mutations validate changed business fields and owner-scoped course,
folder and comment associations; optimistic concurrency remains unchanged.
Step-linked messages and result records carry stable operation identities.

`scripts/test-bot-hardening.mjs`, migration matrix, Bot, Gateway and MCP tests
pass. This foundation does not claim external exactly-once execution: a crash
between a remote side effect and local settlement remains uncertain.

## Accounted execution and recovery

Schema v16 adds persistent requests, budgets, artifacts, summaries, memory
revisions/jobs and thread skill scope. v17 timestamps inbox admission for body
retention. These migrations are new on this branch; do not downgrade a live
database to a pre-v16 binary.

- `ModelClient` bounds JSON responses to 8 MiB and separates auth, quota,
  rate-limit, server, connection and malformed-response failures. Defaults:
  three attempts, 30 seconds per attempt, 120 seconds per chain; Retry-After
  seconds/dates and cancellation are honored. Retries never replay tools.
- Chat, Responses and Anthropic continuation preserve tool pairing and opaque
  reasoning blocks. Multiple returned tools execute **serially**. Refused or
  incomplete outputs cannot trigger tool execution.
- Every physical Bot/vision/associated learning request has an owner/run/task
  attribution. Native learning execution and the browser model proxy both
  account requests; ordinary non-Bot chat is unchanged. SSE observes Chat
  usage, Responses completion usage and Anthropic split usage events.
- Missing usage, interrupted streams and network-unknown results retain a
  reservation across restarts. They are not zero tokens or zero cost.
  Settlement is idempotent and prices are snapshotted at admission, so later
  administrator edits cannot rewrite an inflight request's price.
- Prices are administrator-entered per-million input/output rates with a
  source/version string. No bundled guessed price list. Costs are estimates,
  not provider invoices: cache reads use the input rate, Anthropic cache writes
  use a labeled 2× input estimate. Reservations use the larger of 2× input and
  output rates. Unknown prices block requests when a money cap is enabled.

Defaults, editable in cloud settings:

| Limit | Default |
| --- | --- |
| Run tokens (including associated child/vision/memory requests) | 250,000 |
| Owner daily tokens, UTC request-start day | 1,000,000 |
| Active execution time (persistent waits/approvals excluded) | 900,000 ms |
| Estimated context capacity | 32,000 tokens |
| Run steps | existing policy, 100 by default |
| Run cost | disabled until configured with administrator prices |

SQLite transactions serialize budget reservations across concurrent runs.
Exhaustion pauses rather than succeeds. Increase the appropriate limit, then
use **Explicitly continue**; previous usage and active time remain charged.
For a step-limit pause, also increase the existing policy's maxSteps. Parent
pause/cancel blocks child calls and commits; an interrupted child is not
silently replayed on parent resume. Inspect its evidence before explicitly
requesting another job. Shutdown and database faults have rejection boundaries
in both schedulers. Lifecycle hooks and bounded audit persistence are
best-effort observers; permission and budget gates are not.

## Context, artifacts and skills

Context estimates use UTF-16 length/2 plus a 4,096-token output reserve, not a
tokenizer. Configure capacity no larger than the deployed model supports.
Compaction changes only the model view, preserves complete tool-call/result
pairs and writes an atomic source-range checkpoint with the original history.
Summaries are explicitly **extractive-v1:no-model**: deterministic evidence
indexes, not claims of model-written semantic summaries. Completed short runs
also produce a checkpoint for opt-in memory consolidation. If required user
constraints and recent evidence still do not fit, the run pauses instead of
silently dropping them.

Tool results over 12,000 characters become an owner-scoped SQLite artifact
with preview, ID, byte size and `artifact_read` instructions. `study_record`
reads records omitted by paged `study_read`. Ranges use UTF-16 offsets, up to
12,000 characters; no arbitrary local paths. Limits are 2 MiB per artifact,
50 MiB and 1,000 artifacts per owner. Reads are bounded synchronous operations.
Active/paused/waiting runs retain artifacts; terminal-run artifacts expire with
the configured body retention interval. The full original step evidence is
not replaced by its preview.

Bot skills reuse the existing scope intersection and Markdown parser. Builtin
Markdown/references are included in the Node build; user skills come from
owner-scoped synchronized records. Catalog metadata precedes on-demand body or
reference loading, with revision/source. `null` inherits enabled skills, `[]`
disables all, an ID list intersects with enabled skills. Handout and question
bank guidance cover handouts, cards and review; no parallel skill store or
automatically granted MCP dependency is introduced. Scope is checked again on
each load; missing/disabled MCP dependencies are explained without installing
or authorizing them.

## Auditable memory

Memory is explicit owner/Bot/course scope, with source locator, optional source
revision, revision history, origin and active/stale/deleted status. Course facts
are explicitly retrieved, not guessed into unrelated conversations. Model
injection filters owner and participating Bot before limiting to 20 records
and 8,000 serialized characters. Memory is untrusted data, never permissions.
`record:<table>:<JSON-key>` sources become stale on revision change/deletion;
provide the source record revision when saving such a reference.

Management supports search, paged lists/history, create/edit/delete and restoring
as a **new** revision. Optimistic revision checks prevent lost updates. Deletion
clears active content and retains a tombstone plus audit history, not secure
erasure of historical versions. Automatic consolidation is **off by default**.
When enabled, configure its frequency and token budget; it reads completed
checkpoints and may write learning preferences only. Cursor and all writes
commit together. Source lineage uses the originating message/run, so another
checkpoint of that same old source cannot resurrect deleted memory. Explicit
user save/restore remains possible. Disable aborts an active job and prevents
late publication. Consolidation also consumes the owner and source-run budgets.

## Channel contract, capacity and retention

Manifests describe config fields, secret/public values, replace-or-preserve
semantics, login actions/inputs, login config/public output allowlists and
management capabilities. Empty secret input preserves the saved value. Login
secrets are encrypted server-side; unknown login output is hidden by default.
Generic config/login controls are manifest-driven; WeChat's QR is a trusted
builtin special presentation. Feishu SDK initializes only when needed.
`test-gateway-retention.mjs` registers a third fake channel without adding a
BotRunner platform branch.

| Environment variable | Default / maximum |
| --- | --- |
| `GATEWAY_PENDING_LIMIT` | 1,000 / 10,000 per-account inbox/outbox |
| `GATEWAY_DEDUPE_LIMIT` | 200,000 / 1,000,000 per-account metadata rows |
| `GATEWAY_PENDING_DAYS` | 7 / 365 |
| `GATEWAY_BODY_DAYS` | 30 / 3,650 |
| `BOT_AUDIT_LIMIT` | 100,000 / 1,000,000 per owner, minimum 1,000 |

Inbox envelopes/outbox payloads are capped at 128,000 serialized characters.
Capacity rejection rolls back the batch and cursor; never ACK as persisted
when admission failed. Pending expiry creates an inspectable failed delivery.
Failed/uncertain/sending bodies require explicit operator action, not ordinary
terminal cleanup. Sent/cancelled outbox and completed inbox bodies are cleared
in small batches; active run dependencies are excluded. Stable dedupe metadata
is retained **permanently**, not deleted at day 90. At the metadata cap new
admission stops: inspect pressure and raise capacity within the supported limit
or archive/rotate the channel deliberately; do not delete replay identities to
silence an alert. A full channel can still be stopped/revoked from the Web.
Audit rows expire after 90 days or earlier at the owner capacity limit; long
details are replaced by a size marker. Up to four account attachment workers
avoid global attachment blocking while retaining account order and synchronous
`/stop`. Delivery retry/discard never creates another learning job. Actual
platform deduplication/context-token windows still constrain external retries.

## Verification and evaluation

Implementation commits (no push or merge to main):

- `6b489bc` — main MCP/Gateway integration and legacy schema reconciliation.
- `87dc68c` — scheduler and tool validation foundation.
- `e5de643` — accounted execution, governed context/skills and durable memory.
- `9d5ecef` — manifest management, bounded queues/retention and fake channel.
- `a11e88d` — Bot diagnostics/budget/memory UI and responsive browser coverage.
- `6c6f954` — service regressions, offline fixtures and gated real evaluator.
- `3539f60` — stateless auxiliary continuation and two-client/day admission tests.

Runtime/context/memory landed together because their transaction and ownership
boundaries are integrated; channels, UI and regression/evaluation delivery have
separate commits. This document is committed separately as the handoff record.

Passed on macOS Node 26.3.0 (2026-10-26):

```sh
npm run build
npm run test:api
npm run test:bot
npm run test:cloud
npm run test:tasks
npm run test:gateway
npm run test:mcp
npm run test:bot:hardening
npm run test:bot:management
npm run test:gateway:ui
npm run test:i18n
npm run eval:bot
git diff --check
```

The hardening suite covers the five migration layouts, scheduler/observer
faults, strict tools, restart-safe unknown usage, price snapshots, protocol
retry/cancel/refusal, three SSE usage forms, artifacts, original-history/tool
pair retention, skill scope, memory revision/tombstone/stale/cursor rollback,
stable file/message identities, post-I/O revocation, plugin masking and queue
retention/cursor/dedupe pressure. Existing Gateway review tests exercise real
async stop/revoke/deny windows and child card/handout execution. These are
specific fault injections, not an exhaustive power-loss proof.

Playwright actually saves budgets, creates/edits/deletes/restores memory,
continues a paused task, reads request details, changes skill scope and stops a
task at **390 and 1440 px**. It also verifies the browser child proxy ledger and
paused-parent denial. Gateway UI separately tests credentials, pairing/QR,
reminders, failed/uncertain discard and revoke. Both assert no document/control
overflow or page errors. Screenshots can be retained outside the repo with
`SCREENSHOT_DIR`.

Offline evaluation: **20/20 deterministic scripted scenarios**, including
actual child generation against a fake provider and persisted evidence checks.
This is not a real-model completion rate. Reports record each scenario/repeat,
latency, known/unknown token/cost usage, changed/unrelated records and tool
errors. Handout factual correctness/coverage/teaching clarity have a separate
human 0–4 rubric. Real evaluation uses isolated data, no actual IM delivery and
three repeats per scenario. It is deliberately gated and has **not been run**:

```sh
BOT_EVAL_REAL=1 \
BOT_EVAL_CONFIG=/absolute/path/to/private-cloud-config.json \
BOT_EVAL_MAX_COST=1 \
BOT_EVAL_OUTPUT=/absolute/path/to/report.json \
npm run eval:bot -- --real
```

The private config must contain explicit provider/model credentials and priced
`botBudget.prices`. The total cap is divided across all 60 runs; conservative
reservations can pause an evaluation before exhausting that allowance. Keep
config/reports outside git and authorize paid use before running this command.

Independent acceptance still outstanding: Docker daemon is unavailable
(`docker info` cannot connect to `/var/run/docker.sock`); no Linux image or real
WeChat/Feishu account has been tested in this round. Real-model quality/cost
acceptance is unauthorised and unrun. Existing build CSS/dynamic-import warnings
remain non-fatal. Dependency audit previously reported 15 vulnerabilities;
unrelated dependency upgrades were not attempted. Final permission/recovery
review remains with the main reviewer; the final external-plan checkbox is
intentionally left unchecked.
