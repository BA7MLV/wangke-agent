# External browser worker

The API no longer launches Chromium. Node owns task scheduling, model/media-native execution, and persistence; browser-only tasks are left queued for an authenticated browser worker.

Open the deployed application with `?cloud-worker=1` in an authenticated browser tab. That page claims browser tasks for the current user, renews its lease through task reports, executes `window.__runCloudTask`, and posts completion. Only the claimed task's scoped bearer token can report, authorize, mutate records, or complete it.

Browser leases expire after 30 seconds. A server restart returns browser tasks to `queued`; a disconnected worker is reclaimed by the next claim after the lease expires. Keep this tab open while browser tasks run. Playwright remains a development-only dependency for E2E scripts.
