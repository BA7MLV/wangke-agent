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

- Project sessions bind-mount only `FILES_DIR/projects/<project-id>` at `/workspace`. Independent BOT threads retain their Docker named volume, `wangke-workspace-<thread-id>`. Both persist across command containers.
- Each shell step runs in a fresh non-root container with Node, Python, bash, git and curl. The root filesystem is read-only; only its workspace and temporary directory are writable.
- Commands require approval by default. Approvals bind the exact command and network setting and are consumed once. Cloud settings can deny commands, allow them, or trust selected Bot profiles for long-term authorization. Revoking trust takes effect before the next command.
- Only the trusted broker has the host Docker socket. The API and execution containers never receive it. The execution container receives neither model credentials nor application database/configuration mounts.
- Default network is `none`. Downloads require both `SANDBOX_NETWORK=bridge` in deployment and the cloud policy's network switch to allow access. Bridge networking also permits reachable LAN services; it is not an internet-only egress policy.
- Each command is limited to 120 seconds, 1 CPU, 1 GiB RAM, 128 processes and bounded output. Detached child processes die with the step container. Use persisted `wait` and subsequent steps for recurring work.
- Run a single API/runtime instance per SQLite database. Tasks in the same project execute serially across all its sessions; independent BOT tasks serialize per thread. Different projects can run concurrently up to `BOT_CONCURRENCY` (default 1). Browser writes return `project_busy` while a project task is running. Persisted execution leases keep a project locked after uncertain cancellation or API/broker failure until the broker confirms container removal; cleanup is retried each scheduler tick. Restart recovery does not blindly replay interrupted shell steps: their side effects may already have occurred, so the model receives an interruption result and can inspect its workspace.
- The frontend's “停止当前线程任务” cancels running and scheduled tasks for that thread. `/api/v1/threads/:id/runs` exposes status, steps, wake time and error code.

## Storage and current limits

Project directories live under application `files`, so the existing backup/restore scripts include their regular files together with the database, project IDs, grants and histories. Stop the runtime and broker for a consistent backup. The scripts currently reject symlinks, and restore rejects nested archive files; workspaces containing dependencies/venvs or such files need a separate filesystem backup workflow. **Independent BOT named volumes remain separate and are not included.** Back them up separately before moving or deleting a Docker installation. Container memory/process limits do not impose workspace disk quotas.

Project attachments upload directly into the project directory and messages carry a project-relative path. Generated project artifacts can be opened/downloaded from Project files or the Library folder. Independent BOT attachments are still application files and are not automatically mounted in legacy named volumes; those volumes have no file-browser bridge. A `send_message` attachment must reference a real workspace file to provide a project download link.

This is a bounded autonomous runtime with persisted scheduled continuation, not a distributed worker cluster. Abrupt process loss around external side effects cannot guarantee exactly-once execution. The broker is privileged infrastructure and must not be exposed publicly.

Verification: `npm run test:api`, `npm run test:bot`, `npm run test:projects`, and `npm run build`. After building, `npm run test:projects:e2e` uses Chrome and an isolated real API/database with a deterministic model to verify the frontend workflow and desktop/mobile geometry. Runtime tests use a fake model and sandbox; they do not substitute for an actual Docker end-to-end deployment.

With Docker running and the sandbox image built, `npm run test:sandbox` starts a temporary local broker on port 3001 and verifies real command execution, legacy persistence, shared project mounts, cross-project isolation, non-root execution and cancellation cleanup. It removes its test volume/directories afterwards; run it when port 3001 is free.
