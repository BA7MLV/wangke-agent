# Autonomous Bot deployment

Bot runs on the backend, independent of browser lifetime. The runtime performs multiple model/tool turns, stores each step and its context in SQLite, and polls persisted wake times every second. `wait` lets a task sleep and resume after restart. A task finishes when the agent sends its final answer, asks a question, is cancelled, fails, or reaches its step budget (default 100). Idle agents do not continuously call the model.

## Docker / one-command installation

From this source checkout, with Docker Engine and Compose running:

```bash
./install.sh --agent
```

Open the installer's `/#/setup` URL to initialize the administrator, save model services and configure permissions. Model configuration changes apply without rebuilding containers. Environment settings require container recreation:

```bash
~/.wangke-agent/bin/wangke-agent update
```

The installer builds the execution image, starts the API and sandbox broker, and preserves the broker configuration for subsequent installations and management commands. Use `--public-url https://your-domain` for a public HTTPS deployment and Passkeys. See [Personal Cloud](personal-cloud.md).

Manual Compose deployment:

```bash
# Put a randomly generated SANDBOX_TOKEN (32+ characters) and model settings in .env.
docker build -t wangke-sandbox:0.1.0 -f infra/sandbox/Dockerfile .
docker compose -f compose.yaml -f compose.agent.yaml up -d --build
```

## Local Node API with Docker execution

Build the execution image as above. Run the broker locally with `SANDBOX_TOKEN` and `HOST=127.0.0.1`:

```bash
node infra/sandbox/broker.mjs
```

Start the Node API with the same `SANDBOX_TOKEN`, `SANDBOX_URL=http://127.0.0.1:3001`, and model environment variables. Set `SANDBOX_PROJECTS_DIR` on the broker to the API's absolute `FILES_DIR/projects` path (by default `DATA_DIR/files/projects`). `SANDBOX_UID` and `SANDBOX_GID` must match the API's non-root filesystem owner for project commands. If Docker runs on a different host/path, also set `SANDBOX_PROJECTS_HOST_DIR` to the daemon-visible path. `npm run build` followed by `npm start` serves the UI and API together. Development uses `npm run dev:api` and `npm run dev`. The Node process does not automatically load `.env`; export these variables before starting it.

Compose's agent overlay configures these paths automatically. The broker inspects its own read-only bind mount to find the canonical Docker-host source; a relative `WANGKE_HOST_DATA_DIR` is resolved by Compose, not by the broker. If the installer/API runs as root, project files are assigned to 1000:1000 and the broker maps UID 0 to 1000:1000; command containers remain non-root. Project file management works without Docker; shell commands require the execution layer.

## Projects and conversations

Authenticated server deployments open BOT chat at `/` and `/chat`; `/bot` is an alias. Course Q&A is at `/course-chat`. Local-only use retains the course homepage.

- `/projects` creates a project with an immutable UUID and a directory at `FILES_DIR/projects/<UUID>`. Renaming changes only the display name. Archiving retains the directory and history.
- `/projects/:id` manages independent chat sessions sharing project instructions and files. The Library root shows a project folder opening `/projects/:id/files`, which browses the same physical files as the sandbox. Upload, download, text editing, new directories and revision-checked removal are available.
- A BOT can serve several projects; a project can authorize several BOTs. Each project session selects one authorized BOT. Read grants allow file inspection, write grants also allow file mutations and policy-controlled commands, and manage grants additionally allow renaming the project from the BOT's independent chat. Grants do not grant access to other projects.
- File writes/removals and commands follow the user's global approval policy. A read grant cannot run shell commands. Project command/network policy can narrow global policy. Archiving a project or changing its instructions, policy or grants stops its unfinished tasks; the next task uses the new settings.
- A project session exposes only its workspace tools and bounded sandbox. Existing owner-wide external MCP connectors are excluded until project-scoped connectors are implemented. Independent BOT chats retain their MCP configuration.

See [Project workspaces](project-workspaces.md) for the API and upgrade behavior.

## Execution boundary

- Project sessions bind-mount only `FILES_DIR/projects/<project-id>` at `/workspace`. Ordinary Web/IM BOT conversations use their owner's dedicated `Bot` resource folder as the same persistent bind mount. Incoming attachments and workspace tools share this directory; task subdirectories stay inside it. Access to another authorized resource scope requires an explicit `workspace.projectId` and never switches the shell mount. Legacy thread volumes remain on disk but are no longer the default for Bot profiles.
- Each shell step runs in a fresh non-root container with Node, Python, bash, git and curl. The root filesystem is read-only; only its workspace and temporary directory are writable.
- New sandbox images include `wangke-save SOURCE TARGET` for staged generated artifacts: meaningful workspace-relative names, atomic no-overwrite publication, numbered conflicts and reuse of identical output at the requested/numbered path. Generate `/tmp` inputs and publish in the same shell step, then register the returned path with `study_upload_file`. This is a safe default workflow, not a restriction on arbitrary Python writes; see [file naming and saving](project-workspaces.md#bot-生成文件的安全保存).
- Commands require approval by default. Approvals bind the exact command and network setting and are consumed once. Cloud settings can deny commands, allow them, or trust selected Bot profiles for long-term authorization. Revoking trust takes effect before the next command.
- Chat shows results and necessary questions/confirmations, not Python/shell source, tool logs or progress messages. Commands remain in internal run steps. Shell approvals show a short purpose. Gateway forwards only text, questions, approvals and attachments. In iLink/Feishu, reply `同意` or `拒绝` for a single fully delivered pending approval, or `批准 <ID>` / `拒绝 <ID>` (legacy `/approve <ID>` / `/reject <ID>` also work). The inbound reply captures the exact approval before queuing; multiple pending approvals require an ID, and delayed replies cannot approve a newer operation.
- Only the trusted broker has the host Docker socket. The API and execution containers never receive it. The execution container receives neither model credentials nor application database/configuration mounts.
- New installations, accounts and folders allow command networking by default. Settings → Bot → Permissions → 命令可联网 disables it globally for that account; a folder's network policy can further restrict it. Commands with networking disabled run with Docker network `none`; network-enabled commands use `SANDBOX_NETWORK` (default `bridge`). Explicit saved denials and deployment overrides remain unchanged during upgrades. Bridge networking also permits reachable LAN services; it is not an internet-only egress policy.
- Each command is limited to 120 seconds, 1 CPU, 1 GiB RAM, 128 processes and bounded output. Detached child processes die with the step container. Use persisted `wait` and subsequent steps for recurring work.
- Run a single API/runtime instance per SQLite database. Tasks in the same workspace execute serially across all its sessions, including ordinary BOT conversations sharing the owner's Bot folder. Different workspaces can run concurrently up to `BOT_CONCURRENCY` (default 1). Browser writes return `project_busy` while a workspace task is running. Persisted execution leases keep a workspace locked after uncertain cancellation or API/broker failure until the broker confirms container removal; cleanup is retried each scheduler tick. Restart recovery does not blindly replay interrupted shell steps: their side effects may already have occurred, so the model receives an interruption result and can inspect its workspace.
- The frontend's “停止当前线程任务” cancels running and scheduled tasks for that thread. `/api/v1/threads/:id/runs` exposes status, steps, wake time and error code.

## Storage and current limits

Project directories live under application `files`, so the existing backup/restore scripts include their regular files together with the database, project IDs, grants and histories. Stop the runtime and broker for a consistent backup. The scripts currently reject symlinks, and restore rejects nested archive files; workspaces containing dependencies/venvs or such files need a separate filesystem backup workflow. **Independent BOT named volumes remain separate and are not included.** Back them up separately before moving or deleting a Docker installation. Container memory/process limits do not impose workspace disk quotas.

### System documents

The library's `system` folder contains `AGENTS.md` and `memory/`. Files are the authoritative notebook: existing memories retain `<memory-id>.md`, named notes can use `preferences.md`, and daily diaries use `YYYY-MM-DD.md`. The library, Bot management and Bot `read` / `grep` / `edit` tools share the same files and revision index. Scope, source freshness, tombstones and version history remain managed by the Bot memory service. Editing a stale course fact, including directly on disk, cannot silently refresh its source evidence.

These are real UTF-8 files under `FILES_DIR/system-files/<sha256(owner-id)>/system/`, included in the normal file backup and account reset. Existing database-only instructions and memories are migrated once. External file edits and new named files are indexed on read/list, rather than overwritten by a database snapshot; deleting a known memory file creates a tombstone. Historical recovery is explicit through version restore. SQLite holds metadata, revision snapshots and transactional pending-write intents, not the live authoritative body. Intents are applied only after the outer transaction commits and only if the previous disk content still matches; interrupted writes can resume without clobbering an external edit. Writes use atomic replacement; paths and symlinks are rejected, and stale saves conflict. System documents are not duplicate course/material records and do not count toward course statistics.

Bot `read` lists files or numbered lines with revision and current UTC time. `grep` searches the notebook as described below. `edit` creates a new named note (`create=true`, `content`, `revision=0`), makes exact replacements, or appends to the latest revision. Dated diary creation and appends include server UTC timestamp headings; the filename date uses the user's known timezone. Entries should record observed activity, evidence, decisions, open tasks and uncertainty, not invented experiences or credentials. Notes and diaries are retrieved on demand, not injected wholesale as lasting preferences. New entries preserve their triggering message/run source, and use existing read/write approval policy. Recurring journaling is not enabled automatically; the opt-in preference-consolidation job remains separate.

### Bounded retrieval and recoverable context

- Bot notebook `read` / `grep`, `artifact_read` and `checkpoint_read` accept `maxTokens`: default **4096**, range **2048–8192**. This is a conservative UTF-8/JSON estimate with protocol headroom, **not an exact vendor tokenizer**. The complete returned object, including metadata and its `budget`, must fit. If even essential metadata/evidence cannot fit, the tool returns `result_budget_too_small`, not an unmarked truncation.
- File `read` returns `next: {offset, column, revision}`. Follow all three fields; `offset` is a zero-based line and `column` a UTF-16 offset within that line. This also pages a single huge line without splitting surrogate pairs or losing text. A source change rejects a pinned continuation. Directory reads page their metadata too. Artifact and checkpoint text reads use UTF-16 `nextOffset`.
- `grep` defaults to literal matching, including whitespace, and all literal matching lines are pageable. `mode="relevant"` uses local lexical ranking: phrase matches, term coverage, Chinese bigrams, headings and paths. All owned notebook files are searched **before** ranking/pagination; old diaries are not excluded by the recent-file window. Relevant snippets are diversified (three per file for directory search, up to 50 for one file), deduplicate matching lines already visible in another excerpt, and cite path, revision, scope, status, line range and match column. This is lexical retrieval, not semantic/vector search or verified fact extraction. Follow `nextCursor` with identical filters; source edits/deletions or status changes expire the cursor. Read the cited source before editing or relying on incomplete excerpts.
- Context governance starts above **72%** of configured request capacity, counting tool schemas, metadata, protocol overhead and output reservation. It preserves every system instruction verbatim, the latest actual user request and complete retained tool-call/result pairs. Large tool results become recoverable artifact references. If the mandatory context still cannot fit, the run stops with `context_capacity_exceeded` rather than dropping those instructions.
- Version-2 checkpoints are extractive navigation, not new memory or authorization. They label request/response excerpts, omissions, uncertain evidence, pending steps and versioned notebook references. Raw history and `run_steps` remain intact. Each checkpoint records its source kind/range and SHA-256 hash; recovery checks the original source and fails closed after edits/deletions. Before the latest 40-message chat window, a separate checkpoint links older messages from the **same thread**, and later compaction retains links to earlier checkpoints.
- `checkpoint_read()` lists this thread's saved checkpoints, including completed tasks; follow its `nextCursor` as `cursor` for stable listing. With `checkpointId`, the default `section="history"` recovers original JSON text, `section="requests"` recovers complete original user requests, and `messageIndex` selects an indexed source message. Follow text `nextOffset` with the same selection until null. Recovery is read-only, requires current read permission/approval, and is scoped to the same owner **and thread**. It does not replay tools, consume an old approval or promote an assistant claim into a fact. Re-read current notebook revisions before reusing historical evidence.

These changes do not enable background journaling, introduce model calls/vector services, or replace authoritative files with summaries. Verify with `npm run test:memory-context`, `npm run test:system-files`, and `npm run test:bot:hardening`.

Project attachments upload directly into the project directory and messages carry a project-relative path. Generated project artifacts can be opened/downloaded from Project files or the Library folder. Independent Bot Web/IM attachments and `study_export` / `study_send_file` outputs now appear at the resource root on its next listing (the open library refreshes every five seconds). Historical Gateway `Attachment fileId=…` messages are included. Only committed messages and owner-matched files are imported; unattached uploads are not.

Bot uses the home chat's composer primitives, voice input and expanded editor. Selected/pasted/dropped files stay in a conversation-scoped draft until Send; up to eight files and the caption are committed as one attachment message and one queued run. Each file is owner/project validated. Partial upload failures retain the draft and reuse already uploaded blobs on retry. Web and IM use the same attachment envelope (`attachments` plus `caption`, with legacy single-file fields supported). Image messages show thumbnails and the shared image viewer; historical Gateway hints are interpreted for display only. Tool-reading hints are generated in model context rather than stored as visible chat text.

Schema version 20 adds durable `resource_attachments` import receipts. Copies are atomic, retain original chat-download blobs, avoid overwriting same-name files, recover interrupted installs, and are never re-created after a user moves/deletes the imported resource. Existing course-file placements are reused. Images open in the resource preview; other binary types download instead of going through the text editor. Legacy independent Bot sandbox named volumes still have no file-browser bridge: export/send a file through the attachment tools or write it into an authorized project to make it visible. Internal tool-result artifacts remain in task details.

`study_upload_file({path, name?})` registers an existing file from the current `/workspace` (relative paths also work) and returns an owned `fileId`, name, MIME and size without posting a message. Bot decides which finished artifacts to send with `study_send_file({fileId, caption?})`; `study_export({name, content, send:false})` similarly registers text without sending. Binary PDF/DOCX/ZIP/image transfers use the broker's authenticated `/files/read` endpoint rather than truncated shell stdout. The reader mounts only the current thread/project workspace read-only, disables network, rejects traversal, links and non-regular files, and limits files to 20 MB. Registration requires current read/write permissions, honors exact approvals/cancellation and reuses the same operation's committed fileId on retry. Project reads hold the same durable execution lease as commands. Rebuild/restart both API and sandbox broker to enable this endpoint; no database migration is needed.

Bot context and output capacity come from the account's selected main-model settings rather than an independent 32k default. The old token/day/time defaults and price form are removed from ordinary management. Bot replies may be ordinary text or emoji across all three model protocols; tools are optional. A text-only reply completes the turn, while text alongside tools is delivered once and the tools continue. Context is compacted automatically; if needed, the reply reservation is reduced to 1024 tokens without dropping instructions or the latest request. An irreducible context failure ends with a conversational explanation, not a Continue task control or instructions to operate budgets. Legacy context-paused tasks can recover at startup only when they are not superseded, archived, or carrying uncertain/pending operations or active children. Other diagnostic pauses retain compatibility API semantics. Historical pause messages receive the same readable wording in Web. See `docs/bot-hardening.md` for compatibility API quota semantics. Verify attachment imports and model inheritance with `npm run test:resources`; `npm run test:bot` covers direct replies and recovery; `npm run test:bot:management` covers desktop/mobile previews, downloads and the absence of manual continuation controls.

This is a bounded autonomous runtime with persisted scheduled continuation, not a distributed worker cluster. Abrupt process loss around external side effects cannot guarantee exactly-once execution. The broker is privileged infrastructure and must not be exposed publicly.

Verification: `npm run test:api`, `npm run test:bot`, `npm run test:projects`, and `npm run build`. After building, `npm run test:projects:e2e` uses Chrome and an isolated real API/database with a deterministic model to verify the frontend workflow and desktop/mobile geometry. Runtime tests use a fake model and sandbox; they do not substitute for an actual Docker end-to-end deployment.

With Docker running and the sandbox image built, `npm run test:sandbox` starts a temporary local broker on port 3001 and verifies real command execution, legacy persistence, shared project mounts, cross-project isolation, non-root execution and cancellation cleanup. It removes its test volume/directories afterwards; run it when port 3001 is free.
