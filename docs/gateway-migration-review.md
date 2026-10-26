# Gateway worker isolation and migration acceptance follow-up

Scope: follow-up to `64cf6e7`, restricted to Gateway runtime, Gateway/migration
tests and this standalone record. No agent/cloud/UI implementation, schema,
credential format or external-plan checkbox was changed. This separate document
avoids overlapping the main reviewer's final `bot-hardening.md` additions.

## Confirmed Gateway defect and fix

The independent probe reproduced an unhandled worker rejection while an
unrelated delivery was awaiting its send: the inbox error-status write failed,
but the worker rejection handler was attached only after that send completed.

`GatewayCore` now attaches an account-local catch immediately on worker creation.
It reports `inbound_failed` on that account; if this diagnostic write also fails,
it emits only the fixed code `gateway_inbox_worker_failed` and does not reject.
Both the worker and its cleanup are tracked independently of the spawning tick,
so a projection/delivery failure cannot orphan work from shutdown accounting.

The scheduling/projection/delivery gate now has a unique ownership token rather
than a shared boolean. It is released while waiting for attachment workers,
without releasing their per-account locks. The post-worker projection flush
must reacquire the gate. An older tick's `finally` cannot clear a newer tick's
gate. Inbox processing remains bounded to four accounts, serial within each.

Close marks the gateway stopped, aborts login and attachment controllers, stops
all channel instances with `allSettled`, then drains tracked work. One failed
stop-health write cannot prevent the remaining stops or worker drain. As before,
network adapters must honor their abort signal; this is not a guarantee that an
arbitrary plugin ignoring cancellation can be forcibly terminated.

New `scripts/test-gateway-workers.mjs`, included in `npm run test:gateway`, checks:

- worker failure plus failure-status **and** diagnostic persistence failure
  during an unrelated slow send: no `unhandledRejection` or `rejectionHandled`;
- a healthy account progresses during the fault, the failing account recovers
  after persistence is restored, and account-local health is observable;
- two ticks overlap via slow download/send, without duplicate account admission
  or an old completion releasing the new pass gate;
- an attachment worker remains tracked even if its spawning pass fails during
  projection; close aborts/drains it together with a slow send, despite a failed
  stop-health write; no work is admitted after close.

The original private probe was rerun without editing or committing it:
`Unhandled while other send awaited: []` (no handled-late warning).

## Stronger migration acceptance evidence

`scripts/test-bot-migrations.mjs` still reconstructs the actual historical SQL
layouts from fixed git revisions: empty, v12, MCP13, Gateway13 and Gateway14.
It now goes beyond table checks and opaque string comparisons:

- Legacy fixtures use the real `CloudConfiguration` AES-GCM encryption and a
  private, isolated `credentials.key`. Each reopen verifies key bytes, decrypts
  the model credentials and, where present before migration, MCP credentials,
  channel config, binding context and inbound envelope. A different real key
  must fail authenticated decryption.
- Original-column snapshots verify users/ownership, threads, messages/events,
  a waiting run with context/step count/wake time, its waiting step and pending
  approval, queued cloud task, encrypted config, and existing Gateway inbox,
  pending outbox/attempts/retry time and account/binding cursor/checkpoint. The
  retained checkpoint refers to a real legacy message event. Foreign keys are
  checked before and after runtime exercise. Only account health is excluded
  from byte-for-byte preservation because start/stop intentionally updates it.
- Each layout is opened **twice**. On **each** start the normal MCP SDK HTTP
  transport authenticates to a loopback fake server, discovers and executes an
  owned tool. A different owner is denied without reaching the fake tool.
- Each start also pairs a fake IM peer and actually executes
  IM → persisted message/run → BotRunner fake-model request → owned MCP tool →
  persisted Bot reply → Gateway projection/outbox → fake IM send. Assertions
  verify decrypted model/channel credentials are used, exact MCP calls, model
  request count and final delivered text, not merely a completed run status.
- Missing subsystems are installed by the existing migration and then receive
  real fixtures; an empty database necessarily receives its initial fixture
  after fresh migration. The test does not claim nonexistent old credentials
  were preserved. These newly installed records are checked on the second start.
- Partial-schema rejection remains covered. No new migration was needed.

## Executed checks (macOS Node 26.3.0, 2026-10-26)

Passed:

```sh
npx tsx /private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/gateway-worker-review.mjs
npx tsx scripts/test-gateway-workers.mjs
npm run test:gateway
npm run build:api
npx tsx scripts/test-bot-migrations.mjs
npx tsx scripts/test-gateway-retention.mjs
git diff --check
```

All five migration layouts passed two startups and authenticated MCP + IM/Bot
round trips. Gateway suite also retained its binding/approval/revoke, media,
dedupe/retry, projection, reminder and child-task regressions. Only isolated
fake model/channel implementations and a loopback fake MCP server were used.
No real IM, account, model or paid quota was contacted. Linux/Docker and real
platform acceptance remain separate; final independent acceptance is still the
main reviewer's responsibility and the final plan item remains unchecked.
