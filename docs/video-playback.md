# Video playback

## Playback and processing are separate paths

- The web player resolves a source through `store/videoPlayback.ts`. Cloud video uses the authenticated `/api/v1/resources/courses/:id` URL directly, with cookie credentials. A header-only `HEAD` probe detects missing files and authentication/access errors. Vidstack/native video owns byte-range requests, buffering, seeking and cancellation.
- Offline OPFS/IndexedDB files still use a Blob URL, revoked on replacement/unmount. Token-only background workers retain their authenticated Blob path; bearer tokens are never put into media URLs.
- `getVideoFile()` remains the full-file API for subtitle extraction and other processing. Do not use it to load cloud video into the player.
- The timeline preview mounts its secondary video only while pointing/dragging and uses the same cookie credentials. It must not compete with initial playback while hidden.
- Source resolution is cancellable and bounded. Native video/source errors show a retry action, with a second header-only probe to distinguish expired login, access denial and missing files. An initial playback timeout prevents an endless spinner when a browser reports no error.

## Read-only file transport

`ResourceFiles.openCourse()` authorizes the owner, opens the mapped physical resource with existing safe descriptor traversal, and never migrates/indexes a library. Old unmigrated imports can read their owned upload directly. A missing mapped resource never falls back to its backup. Migration/indexing stays on library/sync/edit paths.

The shared file responder sends:

- Explicit `HEAD` with the real file length and no body/file read.
- `200`, single byte-range `206`, and invalid/unsatisfiable range `416`.
- Revision-based ETags with `If-None-Match` and `If-Range` handling, after authentication.
- `Cache-Control: private, no-cache`: browser caching is allowed, but access must be revalidated. Do not make private video publicly cacheable.
- Inline disposition only for video/audio; documents retain attachment disposition and `nosniff`.
- An auto-closing Node read stream; Fastify destroys it when the client disconnects.

## Import compatibility

Bilibili imports prefer the highest available H.264/AVC rendition and AAC audio rather than blindly choosing higher-resolution HEVC/AV1. Existing Mediabunny remux uses MP4 `fastStart: 'reserve'` and position-aware writes, so the sample tables precede media data. Remux does not re-encode.

This change does not add a general-purpose transcoding service. Unsupported uploaded codecs get an explicit error, not a misleading infinite loader. If needed later, generate compatible playback derivatives asynchronously and preserve originals. HLS/DASH renditions and private object storage/CDN delivery are separate scaling work, not required for progressive MP4 playback.

## Regression checks

```sh
npm exec -- tsx scripts/test-video-playback.mjs
npm exec -- tsx scripts/e2e-video-playback.mjs
npm exec -- tsx scripts/test-resource-folders.mjs
node scripts/test-bilibili-api.mjs
```

The browser test uses a disposable local account/server, a generated Fast Start MP4 with a valid trailing padding box, and a throttled Chromium connection. It asserts a first frame before full download, actual native range requests/seek, credential handling, visible failure/retry, in-flight cancellation, local URL cleanup, and missing-file behavior. It also verifies WebKit progressive playback/seek and actual offline Blob video decoding in both engines. It never uses production data. Requires FFmpeg, Playwright Chrome and WebKit.

The playback HTTP/browser checks, resource folders, Bot resources, Bilibili API, player shortcuts (via `tsx`), and API/Web builds passed locally on 2026-10-29. The additional unchanged `scripts/test-file-store.mjs` fails in WebKit's simulated `no-opfs` case at `fallback persists in IndexedDB`; Chromium's six cases and WebKit's first three cases pass. This storage-test failure is not resolved by the playback change; do not report the entire storage suite as passing.

For manual inspection, `VIDEO_PREVIEW=1 npm exec -- tsx scripts/e2e-video-playback.mjs` serves a disposable player at the printed local URL until SIGTERM.
