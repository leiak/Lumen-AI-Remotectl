# v0.1.0 — MVP

**Tag:** `v0.1.0` (not pushed — this environment has no `origin` configured)
**Commit at release:** `45a3fff`
**Date:** 2026-09-27

This is the first end-to-end cut of **remotectl**: a Node server that shells out to the `claude` CLI, paired with a Capacitor-wrapped React app (iOS + Android) that drives Claude jobs from a phone over a Tailscale-connected REST + WebSocket API.

> v0.1 ships the happy path end-to-end and is honest about the follow-ups still needed. The full manual verification matrix is in **[`docs/ACCEPTANCE.md`](ACCEPTANCE.md)**.

---

## What's in

### Server (`@remotectl/server`)

- **HTTP + WebSocket API** (Express + `ws`), HTTP on `:8787`, WS on `:8788`.
- **SQLite via `libsql`/Drizzle** with migrations on first start.
- **Schema:** 6 tables — `issues`, `comments`, `runs`, `run_events`, `push_devices`, `settings`.
- **REST endpoints** for issues, comments, runs, run events, push-device registration, and settings — all guarded by a Bearer-token middleware.
- **WebSocket broadcast** for issue, run, comment, and approval events (per-issue filter; reconnect-friendly).
- **Scheduler** with atomic `claimNextRun` (one run per server process at a time, `UPDATE … WHERE status = 'queued'`).
- **Heartbeat scheduler** (`server/src/scheduler/heartbeat.ts`) that keeps the runner loop alive and resumes sessions via `issue.currentSessionId` — a reply to an issue re-enters the same Claude session instead of starting a fresh one.
- **Claude Code adapter** (`server/src/adapters/claude.ts`) — spawns `claude` with `--dangerously-skip-permissions --output-format stream-json`, persists stdout frames to `run_events`, and routes tool-approval requests as `kind: 'approval_request'` comments.
- **Push pipeline** (`server/src/push/notify.ts`) firing `task_approval`, `task_done`, `task_failed`, and `task_mention`. **FCM** is wired through; **APNs** is referenced but stubbed.

### CLI (`@remotectl/cli`)

- `remotectl start` — opens SQLite, runs migrations, generates/loads the API key, mounts `createApp()`, prints `HTTP`, `WS`, `Token` lines.
- `remotectl token` — re-prints the API key (for pasting into the phone's Settings).

### App (`@remotectl/app`)

- **Capacitor-wrapped React SPA** with 7 pages:
  - **`App`** — root router.
  - **`Inbox`** — list of issues, live updates over WS.
  - **`IssueDetail`** — issue + comments + live run stream, with `ApprovalCard` for approve/deny and a comment box for replies.
  - **`LiveStream`** — per-issue run-event stream, filtered by `issueId`.
  - **`NewIssue`** — form posting `POST /api/issues` + a kickoff comment, with a "Start immediately" checkbox.
  - **`Stats`** — run/issue counters.
  - **`Settings`** — server URL + API key (persisted in `localStorage`), with **Test connection** button.
- **WebSocket client** (`app/src/ws.ts`) with exponential-backoff reconnect (`baseBackoffMs = 1000`, `maxBackoffMs = 30_000`) and a per-`issueId` filter.
- **Push registration** on iOS/Android via Capacitor.

### Auth

- **Bearer-token only.** The CLI generates a single API key per install and the app sends it on every REST + WS call. There is no per-user concept; this is a single-workstation, single-user MVP.

---

## Test coverage

| Package | Runner | Result |
| --- | --- | --- |
| `server` | `vitest` | **91 / 91 passing** |
| `app` | `vitest` | **91 / 91 passing** |
| `cli` | (no automated test suite — thin wrapper around `server`) | n/a |

Run them all with:

```bash
pnpm test
```

The automated suites cover the unit-level wiring for each of the ten scenarios in `ACCEPTANCE.md`. **End-to-end behavior on a real phone + real Claude install** is verified by hand against that checklist.

---

## Known limitations

These are the gaps we shipped v0.1 with. Each one links to the scenario it most directly affects.

### Networking

- **HTTP and WS bind to `127.0.0.1` only.** The server does not currently listen on the Tailscale interface. To reach the server from a physical phone you must run an SSH reverse-tunnel or a Tailscale port-forward from the workstation's `100.x.x.x` IP back to `127.0.0.1:8787` (and `:8788` for the WS). Details in **SETUP.md → "Connect from a physical phone"**. (Scenario 9.)
- **No automatic Tailscale setup.** The user installs and signs into Tailscale by hand on both devices. The app does not detect or configure the tailnet.
- **Tailscale IP changes are not auto-recovered.** If `tailscaled` reassigns the workstation's IP, the app's stored host becomes stale; the user must edit Settings. MagicDNS hostnames are not yet supported.

### Reliability / scheduler

- **Server-side `since` cursor is unimplemented.** The WS client sends `since: <lastEventId>` in its `hello` frame, but the server does not yet honor it (see `TODO(server-since)` in `app/src/ws.ts`, lines 67–72). "No events lost" during a transient disconnect relies on the server retaining the WS broadcast queue long enough for the client to reconnect, which is not guaranteed. (Scenario 4.)
- **`issue.status` is never flipped to `in_review`.** The schema enum includes `in_review` and the route layer references it, but no code path updates `issues.status` when a run finishes successfully. v0.1 satisfies the run-side `done` transition only. (Scenario 5.)
- **No retry path.** A `Retry` button does not exist in `IssueDetail`, there is no `POST /api/issues/:id/retry` route, and no caller passes `trigger: 'on_retry'` to the scheduler (even though the schema accepts it). A failed run today can only be re-driven by posting a fresh comment, which gets `trigger: 'on_comment'` instead. (Scenario 7.)
- **Single-runner concurrency.** `claimNextRun` serializes one run at a time per server process. Three back-to-back issues execute in sequence, not in parallel. (Scenario 8.)
- **Push is best-effort.** No retry queue, no exponential backoff for `task_*` notifications. A failed push is logged and dropped.

### Adapters

- **Claude Code only.** The adapter registry references Codex and Cursor, but only `claude` is implemented. Other CLIs require a follow-up adapter before they can be selected.

### Mobile (iOS)

- **APNs is not configured.** The push pipeline has the hook (`server/src/push/apns.ts` is a stub); only FCM is wired through end-to-end. iOS push requires the user to provision an APNs key on the Apple Developer portal and place it under `server/`.
- **No code-signing for iOS.** The Xcode project builds locally with the developer's own signing identity. There is no distribution signing, no TestFlight pipeline, no App Store build. iOS reviewers cannot install it from a public link.
- **`cap add ios` must be run once locally** before the first iOS build.

### Android

- **`cap add android` must be run once locally** before the first Android build, and `google-services.json` must be placed under `app/android/app/` to enable FCM. Without it, the app still works in the foreground; only background push is silent.
- **Notifications are best-effort** on Android as well — no Doze-aware backoff.

### Operational

- **No migrations beyond V1.** The schema is created on first start; subsequent migrations will need an `addMigrations` path. v0.1's DB has six tables and no follow-ups yet, so this is a forward-only concern.
- **Workspace root defaults to `$HOME/code`.** Configurable via `CLAUDE_WORKSPACE`, but not surfaced in Settings. (See `server/src/config.ts`.)
- **Single-user assumption.** One API key per install. No multi-user, no roles, no per-project scoping.

---

## Follow-ups

The "known gaps" tracked as follow-up tasks at the bottom of `ACCEPTANCE.md` (in priority order):

1. **WS `since` cursor** — add a monotonic `event_id` per server broadcast and honor the client's `since` param on `hello`. Closes scenario 4's "no events lost" promise.
2. **`issue.status` → `in_review` transition** — in `runner.ts`, after `finishRun(db, runId, 'done')`, also `UPDATE issues SET status = 'in_review' WHERE id = …`. Closes scenario 5.
3. **`Retry` UI + endpoint** — add `POST /api/issues/:id/retry` and a Retry button in `IssueDetail.tsx` for failed runs, using `trigger: 'on_retry'`. Closes scenario 7.
4. **Bind server to Tailscale interface** — drop the `127.0.0.1`-only restriction or detect the tailnet automatically so physical phones can connect without an SSH tunnel.

Additional backlog (not in ACCEPTANCE.md but worth noting):

5. **APNs (iOS) end-to-end** — wire the APNs module in `server/src/push/apns.ts`, document the iOS push setup, add a server test using a mock APNs transport.
6. **Codex + Cursor adapters** — implement `server/src/adapters/codex.ts` and `server/src/adapters/cursor.ts` and a selector in `runner.ts`.
7. **MagicDNS hostname support** in Settings — accept `hostname.tailnet.ts.net` so an IP change doesn't break the app.
8. **Multi-runner concurrency** — switch from a single in-process scheduler loop to a row-level claim that supports multiple workers.

---

## Upgrade notes

There is no prior release. To install from a fresh checkout:

```bash
git clone <repo> remotectl
cd remotectl
pnpm install
pnpm --filter @remotectl/cli build
remotectl start          # prints HTTP, WS, Token
pnpm --filter @remotectl/app build
pnpm --filter @remotectl/app exec cap sync
```

Then paste the `Token` into the phone app's **Settings** page along with `http://<workstation-tailscale-ip>:8787`.

If you're using a physical phone, remember to set up the port-forward from your Tailscale IP back to `127.0.0.1:8787` and `:8788` first — see **SETUP.md**.

---

## License

MIT.
