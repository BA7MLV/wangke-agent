# Strict separation implementation log

## Baseline (2026-10-28)

### Authorized isolated VPS acceptance (completed within stated scope)

Evidence: [separation-vps-acceptance.md](separation-vps-acceptance.md).
The existing production application/edge remain unchanged and HTTPS health is 200.
The independent Linux API image built successfully (300,037,513 bytes); real
SQLite, Argon2, FFmpeg PNG generation and cancellation passed as UID 1000, without
Web/UI/dev compiler dependencies. Building revealed and fixed the duplicate
UID/GID 1000 creation in the API Dockerfile.

Explicit status check: the original VPS Web build was still running after about
80 minutes, stuck in Vite chunk rendering under its 1600 MiB memory cap with severe
swap thrashing; no Web image existed. It was cancelled by stopping only our own
builder, not restarted in parallel or granted extra VPS memory. A successful local
Web build supplied platform-independent static artifacts for the VPS runtime image
and release tests. This does NOT certify a successful VPS full-source Web build.
Six Action SHAs match the GitHub API; GHCR auth endpoint is reachable (401), but
remote CI, publication and registry artifact pulls remain unverified.

The final real-container script exited 0: independent images/native dependencies,
Caddy routing/isolation headers/uploads, unchanged API/edge and same SSE reader
across Web-only replacement, browser lease continuity/fencing, staged API admission,
real sandbox writer barrier, DB+file destructive-failure recovery, stale-candidate
rejection, compatible rollback, coordinated backup, explicit data-loss restore and
persistent restart passed. Real Chromium old-page/service-worker/live-Worker checks
also passed (same-source synthetic variants, NOT historical/native-device coverage).
Live Docker events for another API update/rollback show no overlapping API instance.
Seven restore-point inventories were independently reverified before destruction.

Runtime testing also found and fixed BusyBox `cp -an` skipping the existing assets
volume directory; per-file append now retains old bytes and adds nested new chunks.
Web update: 6.160 s; normal API readiness unavailable sample span: about 16.4 s
(neighboring successful probes bound approximately 16.303–16.511 s). These are
single-run localhost-edge measurements under test resource limits, not registry or
production-SLA numbers. All test containers/networks/volumes/images/builder/cache,
test credentials/data/snapshots and temporary runtime/source files were removed.
Production IDs/images/start times/restart counts remained identical; final HTTPS
health 200 and disk free returned to 13 GiB. Sanitized evidence is under
`docs/evidence/separation-vps-2026-10-28/`.

Step 4's implementation and independent runtime-image/default-topology foundation
are complete. Steps 5/6 remain open for the remote CI/registry, constrained Linux
Web source build, historical/native-client, full long-native/Bot/IM/sandbox and
first-migration/HTTPS acceptance gates below. No production switch or push occurred.

Implementation starts on the current dirty `main` checkout, not a clean historical
revision. Existing resource-folder, system-file, model-setting and optimistic-chat
changes must remain intact. No reset, stash, production deployment or push is part
of this work.

The API currently imports 14 browser-tree modules (including type-only imports),
plus skill parsing and builtin resources. The transitive audit found two actual
environment leaks hidden behind otherwise reusable code: model metadata reads
localStorage, and prompts measure DOM layout. These require explicit adapters,
not relocation into a nominally shared directory. Settings/Zustand, model-list
localStorage cache, material rendering and application resource stores stay Web-only.

Migration map:
- model protocol, metadata projection, text generation, handout IR/rewrite,
  prompts, text/markdown/DOCX parsers, lexical search and skill parsers →
  `packages/study-core`, with explicit domain exports;
- transport contracts remain `packages/contracts`;
- builtin skill documents → study-core assets, never an API read from Web;
- browser storage and display measurement → Web adapters;
- browser-only application tree → `apps/web` after concurrent edits are stable.

Temporary browser entry modules may forward to shared exports; there must be only
one implementation, and no shared module may depend on those forwarding modules.

## Implemented

- `@wangke/study-core`: one implementation of model protocols, prompt generation,
  text generation, handout rewrite/IR, neutral parsers and skill parsing/assets.
  Browser metadata persistence and display measurement are injected adapters.
- `@wangke/contracts`: explicit domain exports and independent build/typecheck.
- API imports shared packages through exports, never through the Web tree; its
  dependencies, TypeScript configs, build and runtime bundler belong to apps/api.
- Root dependencies are development orchestration/tools. Web and API declare
  their own production dependencies. Turborepo is pinned to 2.11.10.
- The API no longer hosts static files or has a `SERVE_WEB` branch. Unknown paths
  return JSON 404 even if static files exist nearby.
- AST boundary checks cover types, exports, dynamic imports, require, finite URL
  loader alternatives, filesystem build inputs, aliases and shared environment
  leaks. Docker COPY/ADD checks reject cross-app inputs and broad/credential copies.
- API-only Dockerfile and independently pruned Web build; runtime image assertions
  are also in the validation workflow. No image has been published.
- Default Compose now separates api/web/proxy; domain, IP and sandbox overrides
  use api. API routes go directly from the stable Caddy edge to API. Source builds
  explicitly add compose.build.yaml (and compose.agent.build.yaml for sandbox).
- `wangke-agent update web` only pulls/replaces Web with `--no-deps`; failed
  readiness attempts Web-only rollback to the previous image ID. It never invokes
  the full-data backup. Hashed assets are retained in an append-only Web volume.
- Web sources, public assets, HTML, Vite/TypeScript configs and i18n verification
  now live exclusively in `apps/web`. Root commands forward to workspaces/Turbo;
  tests and generators use the new paths. No temporary root source mapping remains.
  Vite resolves ORT/PDF/Chart resources from actual dependency locations, not a
  presumed per-workspace node_modules directory. Chart raw loading is excluded
  from development dependency optimization.
- Both native task and Bot schedulers implement deadline-aware quiescence without
  immediately cancelling active work. Bot admission is rechecked after awaited
  sandbox cleanup. Deadline expiry reports unfinished work; close still waits for
  abort settlement and preserves interrupted/recovery states. This is a scheduler
  primitive; the deployment transaction below adds the writer/lease barrier.
- The API now exposes separate liveness/readiness and a one-way drain operation.
  SIGTERM/SIGINT drain before closing Fastify, preserving active task-scoped
  loopback writes while rejecting external writes and new browser claims. IM and
  memory workers stop; local schedulers get a grace deadline, then close/abort.
  Compose uses readiness and a 65-second stop grace for the default 30-second
  drain plus a 30-second forced-exit ceiling. This does NOT establish database /
  file consistency or stop all remote browser leases.
- Release planning follows actual workspace reverse dependencies and an explicit
  last-successfully-deployed manifest. Missing/unavailable baselines and uncertain
  toolchain/lockfile inputs select full builds. Immutable manifest assembly retains
  unchanged image commits and rejects mutable refs or Web-only database changes.
  The CI/deployment integration below consumes these primitives; a candidate is
  never itself a successful deployment.

### Recoverable deployment and candidate CI implementation (local, not certified)

- Added durable `release-storage` / `release-transaction` / `release-docker`
  modules and `release-deploy.mjs`, installed alongside management scripts.
  Explicit manifest updates require a matching successful commit AND canonical
  manifest digest; mutable refs, stale baselines and out-of-scope changes fail.
- Pull/metadata checks and pre-copy precede downtime. After old API drain/stop,
  stop broker and only this installation's writable sandbox mounts, and refuse
  unknown Docker writers. Fence persisted browser leases/permissions, use the
  previous image's SQLite Backup API, verify integrity/schema and DB/files/config
  checksums, and durably seal the recovery point. Host/out-of-band writers must be
  excluded operationally; there is no claim of distributed filesystem locking.
- New API migrates in staged mode with no business admission or task/IM/memory
  schedulers. Loopback-only token-authenticated status/activate validates database
  metadata. Durable activation survives restart. Old in-memory worker tokens die
  with the previous process; saved browser attempts are requeued, native ones
  interrupted. The standalone drain primitive still does not produce a snapshot.
- Before activation intent, failures restore both database and files/config and
  recreate the previous single instance. Corruption/verification failure leaves
  the API offline. After activation intent, lost acknowledgement only permits
  forward recovery, never automatic snapshot overwrite of newly accepted data.
  Copy-on-restore retains failed data; a journal resumes partial rename swaps.
- Added verified backup, compatible-image rollback, and explicit data-loss restore
  using a point's matching release manifest; the latter first snapshots current
  state. Managed lifecycle/update commands share a lock. Implicit upgrades and
  legacy backup/restore bypasses fail closed. Existing Node.js 22+ is required on
  the management host; no infrastructure is installed automatically.
- Optional sandbox images in a full candidate never enable sandbox services on a
  standard install. Recreate failure with an absent API container still permits
  the recovery barrier. Managed installer `--no-start` refreshes scripts only.
- `.github/workflows/release.yml` connects graph selection to independent matrix
  build/push, per-service BuildKit GHA cache, optional verification Turbo remote
  cache, image-sourced DB metadata and immutable candidate manifest collection.
  Manual dispatch only; publish defaults false and requires explicit input plus
  repository opt-in/environment policy. No workflow was dispatched or image pushed.
- Only deployment readiness advances local `last-success.json`; CI cannot promote
  it. Exact run/attempt artifacts and baseline digest guard stale or mixed inputs.
  Linux/amd64 is the current CI image target, not a claim of multi-arch support.

## Validation evidence (local macOS, not Linux deployment certification)

- Latest post-release API graph-pruned tree:
  `/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/wangke-api-isolation-faOKBt/full`.
  Fresh npm ci/typecheck/build (including schema identity), production dependency
  prune and compiled health/readiness/bootstrap/404/drain, staged/activate and
  standalone image-metadata/SQLite backup/verify passed without Web/UI or
  development dependencies. Native modules here are macOS, NOT Linux proof.
- `npm run test:release-recovery`: 20 storage/transaction/Docker-command fault
  cases plus real HTTP staged/activate/Bot/restart/token tests passed. Cases include
  late rename/deletion, empty dirs, browser lease fencing, partial destructive
  migration, lost activation ack, corrupt point, failed verification, crash between
  data renames, explicit data-loss restore, managed backup, unknown container
  writers, missing recreated container, optional-sandbox non-activation, uncovered
  storage paths/mounts/UID and running-container storage drift. Real HTTP worker
  credential succeeds before stop, then cannot report after persisted lease
  fencing even with its bearer map entry deliberately retained in the test.
- `npm run test:install`: 15 installer/legacy Web-update tests passed, including
  management-only refresh preserving config/baseline without invoking Docker.
  `npm run test:release-plan`, `node scripts/test-release-ci.mjs`,
  `npm run test:release-drain`, and `npm run test:memory-context` passed after the
  release integration. Bash syntax, Compose parse, and both workflow YAML parses
  passed. Workflow text/input/assembly checks are not a remote Actions execution.
- `npm run build:web`, API regression, native/FFmpeg/browser task regression,
  `npm exec -- tsx scripts/test-bot-lifecycle.mjs` and boundary negative fixtures
  passed. Web still emits the previously documented CSS/mixed-import warnings.
  There is no `test:bot-lifecycle` npm script; the direct tsx command is the
  successful evidence, not the initially mistyped npm command.
- Docker recheck: default Unix socket absent; only stopped Colima default profile
  exists (4 CPUs/8 GiB/aarch64); `limactl list --json` finds no VM. No VM, package,
  service or registry infrastructure was installed/created. Action-SHA network
  verification was also blocked by local `raw.githubusercontent.com` DNS failure;
  remote resolution/execution still needs validation.
- API graph-pruned tree: `/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/wangke-api-isolation-dRJsXK/full`.
  Fresh npm ci, shared builds, API typecheck/build and production-dependency prune
  passed. Compiled server boot, health, bootstrap status and JSON 404 passed with
  no src, apps/web, React, ReactDOM, Vite or Zustand. Missing API pdfjs-dist was
  detected by the first clean build and declared explicitly before rerunning.
- Latest API graph-pruned tree: `/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/wangke-api-isolation-muF07k/full`.
  Repeated clean install/typecheck/build/prune and compiled startup passed after
  the Web relocation (before the subsequent scheduler quiescence changes).
- Post-lifecycle API graph-pruned tree: `/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/wangke-api-isolation-CH00cl/full`.
  Fresh install/typecheck/build/production prune and compiled health/readiness,
  bootstrap, JSON 404 and drain admission checks passed without Web/dev dependencies.
- Web graph-pruned tree: `/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/wangke-web-isolation-7pHHEe/full`.
  Fresh npm ci, shared builds, Web typecheck, i18n and Vite/PWA build passed with
  no apps/api, Fastify, better-sqlite3, argon2 or server Passkey implementation.
  Root src is absent: all source/config/scripts came from the pruned Web workspace.
  Existing CSS minifier and mixed static/dynamic-import warnings remain.
- API/auth/password/CSRF, real HTTP 512 MiB upload/Range/oversize cleanup, native
  task execution (including FFmpeg and external browser queue), API split, Bot
  hardening/migrations, system files/notebooks, resource folders and model settings
  regression tests passed during this implementation.
- Installer/Web-update mocks: 14 tests passed, including default image pulls,
  explicit source builds, credential preservation, readiness failures and Web-only
  rollback. These mocks do not establish real container continuity.
- Compose default, compatibility split, domain+IP+sandbox and explicit build
  combinations pass `docker compose config --quiet`.
- A targeted Turborepo API build executed only contracts/study-core/api (3 tasks,
  3.031 seconds for this local warm dependency environment). This is not a cold CI
  baseline or deployment downtime measurement.
- After relocation: memory-context, system-file/notebook/instruction, model-settings
  (11 discovery tests), resource folders, native task/FFmpeg/browser-queue, Bot lifecycle,
  API split and 14 installer/Web-update tests passed. Scheduler quiescence tests cover
  natural completion, no new claims, deadline interruption and awaited-cleanup races.
- Real browser regression passed for resource desktop/mobile, system documents
  desktop/mobile and production-static model settings through a separate Web/API
  HTTP proxy. Initial development raw-Chart optimization errors were corrected;
  the resource browser regression was repeated without those errors.
- Release graph/manifest tests passed, including a temporary Git repository proving
  changes from a previously unshipped release are not lost by comparing only HEAD^.
- Standalone esbuild tests now explicitly load the real Chart UMD source through
   a Web-workspace-resolved text plugin (not a stub). Boundary negative fixtures,
   all 7 i18n tests, all 5 optimistic-send tests, all 8 ORT checks and release-plan
   tests passed together after fixing the missing Vite-only alias.
- The project browser E2E was adapted to real folders: create/rename, explicit Bot
   grant, upload/text creation/download, shared disk results, live approval, folder
   history/reload, legacy links, embedded independent Bot chat/read receipts and
   desktop/mobile layout all passed through the separate static Web/API fixture.
- Integrated server drain tests passed: readiness 503 vs liveness 200, external
   writes/claims rejected, live scoped worker reports accepted without expanding
   authorization, repeated drain/close, and real child-process SIGTERM/SIGINT clean
   exit. Scheduler deadline/race tests, API, projects, Bot lifecycle, memory-context
   and Web-update mock regressions also passed after integration.

## Pending / safety gates

- Both resource-folder and system-file sessions confirmed editing had stopped
  before relocation. Their changes and `test:memory-context` were preserved.
  Source/worker/config relocation and clean independent builds complete step 3.
- API/full updates without a verified manifest/baseline still fail closed. Explicit
  managed transactions passed the documented isolated Linux container release and
  recovery tests as well as local fault tests; this is NOT production certification.
- Existing integrated `app` instances must not be run alongside new api. Installer
  refuses a detected running legacy app; production migration is not authorized or
  performed. Existing data/credentials have not been moved or rewritten.
- Production requires reachable, already-published independent image references
  (`WANGKE_API_IMAGE`, `WANGKE_WEB_IMAGE`, optional broker/sandbox refs), preferably
  digests. A registry has not been verified from the target server. The fallback
  local tags are for explicit source-build mode, not claimed published images.
- The local Docker socket is still absent, but the authorized VPS supplied a real
  Linux daemon. API native modules/images, Caddy, Web-update SSE/browser lease
  continuity, same-source old-page/PWA/Worker, recovery/rollback and measured
  unavailability are now verified within that isolated scope. Linux Web source
  bundling did not finish under the 1600 MiB cap; local static output supplied its
  runtime-image test. Historical protocol/native-device compatibility, full PWA
  install/offline upgrades, long native/Bot/IM drain/reconnect, complete optional
  sandbox/broker and first legacy app/HTTPS migration are still unverified.
- CI build/push/cache/manifest and deployment-baseline promotion code is integrated
  and locally tested, but no remote run/publication/deployment has occurred.
  End-to-end CI and registry validation remain pending; step 5 stays unchecked.
- npm currently reports 17 dependency advisories. No unrelated forced upgrades or
  automatic audit fix was performed as part of this architecture migration.

Do not treat this intermediate checkout as production-ready or run an implicit
all-service upgrade. Continue the original plan without dropping these gates.
