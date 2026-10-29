# Parallel tool execution

Bot and interactive Chat run independent, explicitly safe reads in bounded batches of **four**. This is asynchronous I/O concurrency within one model response; calls that need another call's result belong in a later model round.

## Scheduling contract

- `packages/study-core/src/utils/toolBatch.ts` is the shared scheduler. Consecutive safe reads overlap. A write, user interaction, shell command, unknown tool or MCP call is a serial barrier: earlier work settles before it starts, and later work waits for it.
- Bot plugins opt in with `parallelSafe(args)`. Read permission alone is insufficient: sending a file and cancelling a child job have side effects. Permission and schema checks still apply; tools requiring approval run serially. New plugins default to serial.
- Chat explicitly lists its read/search tools. Visual output, course-context changes and user questions remain ordered. Background generation workers retain serial execution because their authorization uses a single scoped `permissionId`; interactive Chat uses parallel reads.
- Each admitted Bot invocation is charged synchronously against the existing step budget. Chat retains duplicate-call and token-budget guards. Exhaustion prevents further admission; already admitted reads settle before finalization.
- Ordinary tool errors become individual tool results. Fatal failures drain admitted work before the run pauses/fails. Cancellation stops new admission and prevents late results from committing. Existing per-tool Bot timeouts remain in force.

## Transcript, protocols and UI

Results may arrive out of order but are saved by invocation ID in model-call order. Bot persists each completed step and reconstructs missing results after a restart without replaying commands. Chat serializes asynchronous transcript saves; blocking-tool checkpoints include all preceding results.

OpenAI Chat/Responses use the protocol's default multi-call behavior (no `parallel_tool_calls: false`). Omitting optional switches also keeps compatible providers working. Anthropic multi-call responses are enabled; both serializers group the batch's `tool_result` blocks into one following user message and preserve native continuation items.

Chat's status rows, elapsed times and results use invocation IDs rather than a shared timer or the last tool name. The UI shows the active parallel count, updates each row independently, and preserves the trace after reload. Historical traces without IDs remain readable.

## Verification

```sh
npm run test:tool-parallel
node scripts/test-qa-runner.mjs
npx tsx scripts/test-bot-lifecycle.mjs
# Against a local Vite dev server; isolated browser context, fake model, no API key:
BASE_URL=http://localhost:5173 node scripts/e2e-tool-parallel.mjs
```

Tests gate real execution to verify overlap without timing benchmarks, four-call admission limits, write/approval barriers, reverse completion, independent failures, cancellation, budget limits, restart recovery, protocol result IDs and durable UI traces.

Protocol references: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use).
