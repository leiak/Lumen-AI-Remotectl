# Acceptance Checklist (v0.1)

This is a **manual verification checklist** for the remotectl mobile agent app. v0.1 is the first end-to-end cut: server shells out to `claude`, app is a Capacitor-wrapped React SPA that talks to the server over REST + WebSocket. Each scenario below describes what a human tester does on a real workstation + phone (Tailscale) and what they should observe.

Each row is annotated with one of:

- `[x]` — verified by automated tests in this repo (`server` and `app` packages each ship a `vitest` suite that currently reports 91/91 passing on both).
- `[~]` — partially supported by the implementation; needs follow-up or hand-verification to confirm.
- `[ ]` — pending manual verification (no automated coverage, or covers a code path that only runs on a real device).

The honest assessment column lists the files / tests that back the scenario (or the gap).

---

## 1. New Issue + Immediate Run

Open the app, tap **+ New Issue**, fill title + workspace, leave **Start immediately** checked, tap **Create**. Verify Claude starts streaming output on the Live Stream page.

- **What to test**
  - New Issue form posts to `POST /api/issues`, then fires a kickoff comment to `POST /api/issues/:id/comments`.
  - The scheduler picks up the queued run via `claimNextRun` and the runner spawns `claude`.
  - Live Stream page (`/issues/:id/stream`) renders `run_event` frames in real time over the WebSocket.
- **Expected result**
  - `runs.status` transitions `queued → running → done`.
  - `issue.status` becomes `in_progress`.
  - Live Stream page shows streaming output and eventually a "connected" status indicator.
- **Honest assessment**
  - The kickoff-on-create flow is exercised by `app/src/__tests__/NewIssue.test.tsx` and `server/src/__tests__/routes.test.ts` (`POST /api/issues` + `POST /api/issues/:id/comments`).
  - LiveStream rendering is exercised by `app/src/__tests__/LiveStream.test.tsx`.
  - The runner's spawn + finish path is exercised by `server/src/__tests__/runner.test.ts`.
  - **Not exercised**: the full chain of "form submit → spawn real `claude` process → real stdout frames over real WebSocket". That requires a real phone + a real Claude install.

Status: `[~]` — unit-tested in pieces; manual verification of the end-to-end Claude spawn is required.

Backing code: `app/src/pages/NewIssue.tsx`, `app/src/pages/LiveStream.tsx`, `server/src/scheduler/runner.ts`, `server/src/routes/issues.ts`.

---

## 2. Approval Prompt + Push Notification

Make Claude ask for a tool approval (e.g. ask it to run `rm -rf /tmp/x`). Verify the app receives a push notification, the IssueDetail page shows an `ApprovalCard`, tapping **Approve** resumes the run.

- **What to test**
  - Claude emits an `approval_request` event.
  - Server persists it as a comment with `kind: 'approval_request'` and broadcasts `approval.requested` over WebSocket.
  - Push notification fires (if device token is registered).
  - App's `ApprovalCard` POSTs a comment with body `yes` (or `no`) — server routes that as `kind: 'approval_response'`, broadcasts `approval.responded`, but **does not** spawn a new run.
- **Expected result**
  - Push notification arrives.
  - IssueDetail page shows the question with **Approve / Deny** buttons.
  - On approve, Claude continues the existing run (resumed via `currentSessionId`).
- **Honest assessment**
  - Server-side approval persistence + broadcast is exercised by `server/src/__tests__/runner.test.ts` ("persists approval_request event as a comment and broadcasts approval.requested") and `server/src/__tests__/routes.test.ts` ("with body 'yes' persists as approval_response and broadcasts approval.responded", "with body 'yes' does NOT create a new run").
  - `ApprovalCard` UI is exercised by `app/src/__tests__/ApprovalCard.test.tsx`.
  - Push notification delivery on a real device is not covered by tests.
- **Not exercised**: real APNs/FCM delivery.

Status: `[~]` — server path + app UI tested; push delivery and the "approve resumes existing run" path need manual verification.

Backing code: `server/src/scheduler/runner.ts` (lines 70–100), `app/src/components/ApprovalCard.tsx`, `server/src/push/notify.ts`.

---

## 3. Resume Existing Session

Create an issue, let Claude write some code, then in the app reply "继续" (continue) in the comment box. Verify the next run reuses the same Claude session.

- **What to test**
  - First run completes; runner persists `session_id` into `issues.currentSessionId` (see `runner.ts` line 126–128).
  - User comment posts via `POST /api/issues/:id/comments` with body `继续` (or anything that isn't `yes`/`no`). Route enqueues a new run with `trigger: 'on_comment'`.
  - Scheduler claims the run. Runner sees `issue.currentSessionId` and calls the adapter with `{ resume: '<session>', prompt }` instead of `{ fresh: true, prompt }`.
- **Expected result**
  - The second run continues in the same conversation context — Claude remembers the prior code.
  - No new session is started; the session id is unchanged.
- **Honest assessment**
  - Session persistence is exercised by `server/src/__tests__/runner.test.ts` ("persists currentSessionId after a successful run").
  - Resume vs. fresh selection is exercised by `server/src/__tests__/runner.test.ts` ("uses fresh:true when the issue has no currentSessionId" / "uses resume:<session> when the issue already has a currentSessionId").
  - **Not exercised**: that Claude itself actually resumes context from the persisted session id (depends on the `claude --resume <id>` contract).

Status: `[~]` — resume vs. fresh dispatch is verified by tests; whether Claude honours `--resume` is a real-Claude behavior to confirm manually.

Backing code: `server/src/scheduler/runner.ts` (lines 58–60, 126–128).

---

## 4. Network Drop for 30 Seconds (Reconnect)

While Claude is streaming, toggle airplane mode on the phone for ~30 seconds, then reconnect. Verify the app reconnects automatically and doesn't lose events.

- **What to test**
  - Phone drops Wi-Fi/cellular. Server's WebSocket is closed by the network stack (or stays half-open).
  - App's `WsClient` (`app/src/ws.ts`) sees the `onclose` event, schedules a reconnect with exponential backoff (`baseBackoffMs = 1000`, `maxBackoffMs = 30_000`).
  - Once network returns, the client reconnects and the WS starts receiving events again.
- **Expected result**
  - App shows "disconnected" then "connected" again without user action.
  - No manual page reload required.
- **Honest assessment**
  - Reconnect with exponential backoff is exercised by `app/src/__tests__/ws.test.ts` and `app/src/__tests__/Inbox.ws.test.tsx` / `IssueDetail.ws.test.tsx`.
  - **Gap**: the server does not yet honor the `since` cursor the client sends in the `hello` frame — see the `TODO(server-since)` comment in `app/src/ws.ts` (lines 67–72). Until the server attaches a monotonic `event_id` per broadcast, "no events lost" relies on the server retaining the WS broadcast queue long enough for the client to reconnect, which is not guaranteed.
  - **Not exercised**: a real radio drop on a real device.

Status: `[~]` — reconnect logic tested; "no events lost" promise depends on the unimplemented `since` cursor (see follow-up tasks).

Backing code: `app/src/ws.ts`, `app/src/api/ws.ts`.

---

## 5. Normal Exit (Run Completes Successfully)

Let Claude finish a task without errors. Verify `run.status = done` and `issue.status = in_review`.

- **What to test**
  - Claude's underlying process exits with code 0.
  - Runner calls `finishRun(db, runId, 'done')` (line 130 of `runner.ts`).
  - Runner broadcasts `run.finished` with `exit_code: 0`.
  - Issue moves to `in_review` for human review.
- **Expected result**
  - Inbox and IssueDetail show the issue as finished.
  - Push notification of kind `task_done` arrives (if push is configured).
- **Honest assessment**
  - `run.status = done` on exit-0 is exercised by `server/src/__tests__/runner.test.ts` ("spawns adapter, persists events, and finishes the run").
  - `task_done` push is wired in `runner.ts` (lines 132–142) but not covered by an automated test that asserts delivery.
  - **Gap**: the runner does NOT automatically transition `issue.status` to `in_review`. The schema enum includes `in_review` and the route references it, but no code path flips `issues.status` to `in_review` when a run finishes successfully. This scenario is therefore only **partially** satisfied at the data level (run-side yes; issue-side no).
- **Not exercised**: end-to-end on a real device, and the issue-side status transition.

Status: `[~]` — run-side status verified; issue-side `in_review` transition is a known gap (follow-up).

Backing code: `server/src/scheduler/runner.ts` (lines 130–142), `server/src/db/schema.ts`.

---

## 6. Kill Claude Mid-Run

While a run is in progress, on the workstation run `pkill claude` (or otherwise SIGKILL the process). Verify the app shows the run as failed and a push notification of kind `task_failed` arrives.

- **What to test**
  - Claude process is killed; `claude` adapter's `done` promise resolves with a non-zero `exitCode`.
  - Runner calls `finishRun(db, runId, 'failed')` (line 130 of `runner.ts`).
  - Runner broadcasts `run.finished` with a non-zero `exit_code`.
  - Runner fires `task_failed` push notification (best-effort).
- **Expected result**
  - App shows the run as failed.
  - Push notification "run failed" arrives on the phone.
- **Honest assessment**
  - The "non-zero exit → failed" branch is exercised by `server/src/__tests__/runner.test.ts` indirectly via the `exitCode === 0 ? 'done' : 'failed'` branch in `finishRun`.
  - The `spawnFailed` path (adapter throws before any process is spawned) is exercised by `server/src/__tests__/runner.test.ts` ("returns spawnFailed and marks run failed when adapter.start throws"). That's a slightly different code path than SIGKILL of an already-running process.
  - **Not exercised**: real signal delivery and the `task_failed` push notification in flight.

Status: `[~]` — failure paths are tested for spawn-time errors; runtime SIGKILL + push delivery needs manual verification.

Backing code: `server/src/scheduler/runner.ts` (lines 105–121, 130–142).

---

## 7. Click Retry from IssueDetail

In the IssueDetail page for a failed run, tap a **Retry** button. Verify a new run is enqueued and starts.

- **What to test**
  - IssueDetail page surfaces a "Retry" button for failed runs.
  - Tapping it posts to a retry endpoint or fires a comment that triggers a new run with `trigger: 'on_retry'`.
  - Scheduler claims and runs it.
- **Expected result**
  - A new run row appears with status `queued → running`.
  - The previous failure is replaced in the UI with the new attempt.
- **Honest assessment**
  - **The retry UI does not exist yet.** A search across `app/src/**` finds no retry button, no retry API method, and no retry trigger path. The `trigger` enum in `server/src/db/schema.ts` includes `'on_retry'`, and `enqueueHeartbeat` in `server/src/scheduler/heartbeat.ts` accepts the value, but no route or page wires it up.
  - The closest existing behavior is "post a comment" from IssueDetail, which triggers `on_comment` rather than `on_retry`. That works, but it isn't a dedicated retry action.
- **Recommended follow-up**: file a task to add a `POST /api/issues/:id/retry` route (or a comment-with-special-body convention) and a Retry button in `IssueDetail.tsx` that surfaces it for `status === 'failed'` runs.

Status: `[ ]` — **not implemented**. This scenario cannot pass until a follow-up task lands the retry UI + endpoint.

Backing code (gaps): `app/src/pages/IssueDetail.tsx` (no retry button), `app/src/api/client.ts` (no retry method), `server/src/routes/issues.ts` (no retry route).

---

## 8. Three Concurrent Issues

Create three issues back-to-back. Verify their Live Stream pages don't interleave events.

- **What to test**
  - Three `POST /api/issues` calls, each followed by a kickoff comment, enqueue three runs.
  - Scheduler's `startLoop` calls `claimNextRun` once per tick; `claimNextRun` uses an atomic `UPDATE … WHERE status = 'queued'` and returns the claimed row (or `null` if none). Only one run is in flight at a time per server process.
  - Each `LiveStream` page filters incoming `run_event` frames by `issueId`, so a viewer of Issue A never sees Issue B's stdout.
- **Expected result**
  - Three runs execute sequentially (one at a time), each producing its own stream.
  - On any single issue's Live Stream page, only that issue's events appear.
- **Honest assessment**
  - Atomic claim is exercised by `server/src/__tests__/scheduler.test.ts` (queued → claimed → no double-claim).
  - Per-issue event filtering is exercised by `app/src/__tests__/LiveStream.test.tsx` and `IssueDetail.ws.test.tsx`.
  - **Not exercised**: three concurrent real Claude processes (and even in v0.1, `claimNextRun` only runs one at a time — concurrency is serialized at the scheduler level, not parallel).

Status: `[~]` — atomic claim + per-issue filter tested; behavior on real device needs manual verification.

Backing code: `server/src/scheduler/heartbeat.ts` (`claimNextRun`), `app/src/pages/LiveStream.tsx` (per-`issueId` filter on line 43).

---

## 9. Tailscale Restart

Restart the Tailscale daemon on the workstation (or take the phone offline briefly to force Tailscale to renegotiate). Verify the app reconnects without manual action.

- **What to test**
  - Workstation's `tailscaled` restarts; existing 100.x.x.x IP is briefly unreachable.
  - App's WS sees `onclose`, reconnects with exponential backoff.
  - Once Tailscale is back up, the app reconnects and resumes receiving events.
- **Expected result**
  - App reconnects without user action.
  - If the Tailscale IP changes, the user has to update Settings (the app stores a host string in `localStorage`).
- **Honest assessment**
  - Reconnect on transient disconnect is exercised by `app/src/__tests__/ws.test.ts` and the `*.ws.test.tsx` files.
  - **Gap**: if Tailscale assigns a new IP, the stored host in Settings becomes stale — there's no MagicDNS-style stable hostname resolution in the app. The user must edit Settings to pick up the new IP. This is a documented limitation, not a bug.

Status: `[~]` — transient reconnect is tested; stable-across-IP-restart requires the user to update Settings (documented).

Backing code: `app/src/ws.ts`, `app/src/pages/Settings.tsx`, `app/src/storage.ts`.

---

## 10. Restart the App

Kill the app (or force-stop on Android) and reopen it. Verify the inbox, issues, and live runs reload from the server.

- **What to test**
  - App process is killed; `localStorage` (host + apiKey) persists; in-memory React state does not.
  - On next launch, Inbox calls `GET /api/issues`, IssueDetail calls `GET /api/issues/:id` + `GET /api/issues/:id/comments`, LiveStream connects a fresh WS.
  - All data is fetched from the server (no offline cache).
- **Expected result**
  - Inbox, IssueDetail, LiveStream all show the same state as before the kill (modulo any in-flight events that happened during the downtime).
  - User does not need to re-enter host or apiKey (those survive in `localStorage`).
- **Honest assessment**
  - Mount-time fetch is exercised by `app/src/__tests__/app.test.tsx`, `Inbox.ws.test.tsx`, `IssueDetail.ws.test.tsx`, `LiveStream.test.tsx`.
  - Persistence of host/apiKey across launches is exercised by `app/src/__tests__/Settings.test.tsx`.
  - **Not exercised**: a real app process kill (this environment can't kill a phone process).

Status: `[~]` — fetch-on-mount + storage persistence tested; real app kill needs manual verification.

Backing code: `app/src/pages/Inbox.tsx`, `app/src/pages/IssueDetail.tsx`, `app/src/pages/LiveStream.tsx`, `app/src/storage.ts`.

---

## Summary

| # | Scenario | Status | Notes |
| --- | --- | --- | --- |
| 1 | New Issue + Immediate Run | `[~]` | Unit-tested; full E2E needs real Claude + real phone |
| 2 | Approval Prompt + Push | `[~]` | Server + UI tested; push delivery needs real device |
| 3 | Resume Existing Session | `[~]` | Resume vs. fresh dispatch tested; Claude's `--resume` needs manual |
| 4 | 30s Network Drop | `[~]` | Reconnect tested; "no events lost" needs `since` cursor (gap) |
| 5 | Normal Exit (`done`, `in_review`) | `[~]` | Run-side OK; issue-side `in_review` transition is a gap |
| 6 | Kill Claude Mid-Run | `[~]` | Failure paths tested; real signal + push needs manual |
| 7 | Click Retry from IssueDetail | `[ ]` | **Not implemented** — no retry UI, no retry endpoint |
| 8 | Three Concurrent Issues | `[~]` | Atomic claim + per-issue filter tested; real concurrency needs manual |
| 9 | Tailscale Restart | `[~]` | Reconnect tested; if IP changes, user must update Settings |
| 10 | Restart the App | `[~]` | Fetch-on-mount + storage tested; real kill needs manual |

### Known Gaps (Follow-up Tasks)

1. **Server-side `since` cursor for WS resume** — the client sends `since: <lastEventId>` in its `hello` frame but the server doesn't yet honor it. Required for the "no events lost" promise in scenario 4.
2. **Issue status → `in_review` transition** — the runner completes the run but doesn't flip `issue.status`. Required to fully satisfy scenario 5.
3. **Retry UI + endpoint** — no retry button, no retry route, no `trigger: 'on_retry'` callers. Required to satisfy scenario 7.
4. **Stable hostname handling** — if Tailscale reassigns an IP, the app falls back to "user must edit Settings". Could be smoothed by supporting MagicDNS hostnames or a hostname alias.
