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
