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

Start the Node API with the same `SANDBOX_TOKEN`, `SANDBOX_URL=http://127.0.0.1:3001`, and model environment variables. `npm run build` followed by `npm start` serves the UI and API together. Development uses `npm run dev:api` and `npm run dev`. The Node process does not automatically load `.env`; export these variables before starting it.

## Execution boundary

- Each thread has its own Docker named volume, `wangke-workspace-<thread-id>`, mounted at `/workspace`. This is also where agents can keep notes, scripts, Python virtual environments and Node dependencies.
- Each shell step runs in a fresh non-root container with Node, Python, bash, git and curl. The root filesystem is read-only; only its workspace and temporary directory are writable.
- Commands require approval by default. Approvals bind the exact command and network setting and are consumed once. Cloud settings can deny commands, allow them, or trust selected Bot profiles for long-term authorization. Revoking trust takes effect before the next command.
- Only the trusted broker has the host Docker socket. The API and execution containers never receive it. The execution container receives neither model credentials nor application database/configuration mounts.
- Default network is `none`. Downloads require both `SANDBOX_NETWORK=bridge` in deployment and the cloud policy's network switch to allow access. Bridge networking also permits reachable LAN services; it is not an internet-only egress policy.
- Each command is limited to 120 seconds, 1 CPU, 1 GiB RAM, 128 processes and bounded output. Detached child processes die with the step container. Use persisted `wait` and subsequent steps for recurring work.
- Run a single API/runtime instance per SQLite database. Tasks in the same thread execute serially. Restart recovery does not blindly replay interrupted shell steps: their side effects may already have occurred, so the model receives an interruption result and can inspect its workspace.
- The frontend's “停止当前线程任务” cancels running and scheduled tasks for that thread. `/api/v1/threads/:id/runs` exposes status, steps, wake time and error code.

## Storage and current limits

The existing backup script covers application data/configuration. **Sandbox named volumes are separate and are not included in that backup.** Back them up separately before moving or deleting a Docker installation. Container memory/process limits do not impose workspace disk quotas.

Uploaded application attachments are not automatically mounted in the sandbox. Generated workspace files remain in its volume; the current UI does not yet provide a workspace file browser/download bridge. A `send_message` attachment is a message, not an exported artifact.

This is a bounded autonomous runtime with persisted scheduled continuation, not a distributed worker cluster. Abrupt process loss around external side effects cannot guarantee exactly-once execution. The broker is privileged infrastructure and must not be exposed publicly.

Verification: `npm run test:api`, `npm run test:bot`, and `npm run build`. Runtime tests use a fake model and sandbox to verify task state transitions; they do not substitute for an actual Docker end-to-end deployment.

With Docker running and the sandbox image built, `npm run test:sandbox` starts a temporary local broker on port 3001 and verifies real command execution, workspace persistence, non-root execution and mount isolation. It removes its test volume afterwards; run it when port 3001 is free.
