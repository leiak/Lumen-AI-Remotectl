import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues, runs, runEvents, comments } from '../db/schema.js';
import { ClaudeAdapter, type ClaudeEvent, type ClaudeHandle } from '../adapter/claude.js';
import { claimNextRun, finishRun } from './heartbeat.js';
import { PendingApprovals } from './pending.js';
import type { RouteEvent } from '../events/translate.js';
import type { NotifyKind, NotifyPayload } from '../push/notify.js';
import crypto from 'node:crypto';

export type RunResult =
  | { kind: 'ok'; sessionId: string | null; exitCode: number }
  | { kind: 'runNotFound' }
  | { kind: 'spawnFailed'; error: string };

export interface RunOnceOpts {
  db: Db;
  runId: string;
  issueId: string;
  adapter: ClaudeAdapter;
  broadcast: (msg: RouteEvent) => void;
  /**
   * Optional best-effort push notification hook. Wired in when the runner is
   * hosted in the same process as `notify()`. Wrapped in try/catch by the
   * caller so it never breaks the run flow.
   */
  notify?: (kind: NotifyKind, payload: NotifyPayload) => Promise<void>;
  /**
   * Registry of in-flight approval requests. The runner registers when it sees
   * an `approval_request` event and awaits the user's yes/no before continuing.
   * If omitted, the runner still records/broadcasts the request but doesn't
   * block on it (useful for tests that don't care about approval plumbing).
   */
  pendingApprovals?: PendingApprovals;
}

export async function runOnce(opts: RunOnceOpts): Promise<RunResult> {
  const issue = await opts.db.select().from(issues).where(eq(issues.id, opts.issueId)).get();
  if (!issue) return { kind: 'runNotFound' };

  // Build prompt: issue title + comment history
  const history = await opts.db.select().from(comments).where(eq(comments.issueId, opts.issueId)).orderBy(comments.createdAt).all();
  const prompt = [
    `Issue: ${issue.title}`,
    `Workspace: ${issue.workspacePath}`,
    '',
    'Conversation history:',
    ...history.map((c) => `[${c.authorType}] ${c.body}`),
  ].join('\n');

  // Ensure the run row exists so finishRun can update it. In production the run
  // was created by the route; in unit tests we may be called with a fresh id.
  await opts.db.insert(runs).values({
    id: opts.runId,
    issueId: opts.issueId,
    status: 'running',
    trigger: 'manual',
    createdAt: new Date(),
  }).onConflictDoNothing().run();

  opts.broadcast({ kind: 'run.started', runId: opts.runId, issueId: opts.issueId });

  let handle: ClaudeHandle;
  try {
    // Resume if there's a currentSessionId; otherwise fresh.
    const adapterOpts = issue.currentSessionId
      ? { resume: issue.currentSessionId, prompt }
      : { fresh: true, prompt };
    handle = opts.adapter.start(adapterOpts, async (evt: ClaudeEvent) => {
      // Persist to run_events (fire and forget — don't block event delivery)
      opts.db.insert(runEvents).values({
        runId: opts.runId,
        stream: evt.type === 'error' ? 'stderr' : 'stdout',
        content: JSON.stringify(evt),
        createdAt: new Date(),
      }).run().catch((e) => console.error('runEvents insert failed:', e));

      if (evt.type === 'approval_request') {
        const cid = crypto.randomUUID();
        // Persist as agent comment so the user can see it on the IssueDetail page.
        // Await the insert so we never broadcast a commentId that doesn't exist yet.
        try {
          await opts.db.insert(comments).values({
            id: cid,
            issueId: opts.issueId,
            authorType: 'agent',
            body: evt.question,
            kind: 'approval_request',
            createdAt: new Date(),
          }).run();
        } catch (e) {
          console.error('comments insert failed', { runId: opts.runId, issueId: opts.issueId, err: e });
          // Don't broadcast — clients would see a phantom commentId.
          return;
        }
        opts.broadcast({ kind: 'approval.requested', issueId: opts.issueId, commentId: cid });
        if (opts.notify) {
          try {
            await opts.notify('approval_required', {
              issueId: opts.issueId,
              runId: opts.runId,
              message: evt.question,
            });
          } catch (e) {
            console.error('push notify failed', { kind: 'approval_required', runId: opts.runId, err: e });
          }
        }

        // If a PendingApprovals registry is wired in, await the user's
        // response before letting the runner return from this event. The
        // HTTP route resolves the pending promise when an `approval_response`
        // comment arrives; on rejection (e.g. run cancelled) we propagate.
        if (opts.pendingApprovals) {
          try {
            const response = await new Promise<'yes' | 'no'>((resolve, reject) => {
              opts.pendingApprovals!.register(opts.issueId, {
                runId: opts.runId,
                resolve,
                reject,
                createdAt: Date.now(),
              });
            });
            handle.respond(response);
          } catch (e) {
            console.error('approval await failed:', { issueId: opts.issueId, err: e });
            // Don't rethrow — surfacing the error would crash the adapter's
            // onEvent pipeline. The run continues; the user's intent is lost
            // but no crash.
          }
        }
        return;
      }

      opts.broadcast({ kind: 'run.event', runId: opts.runId, issueId: opts.issueId, event: evt });
    });
  } catch (e) {
    const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    await finishRun(opts.db, opts.runId, 'failed', error);
    opts.broadcast({ kind: 'run.finished', runId: opts.runId, issueId: opts.issueId, exit_code: -1 });
    if (opts.notify) {
      try {
        await opts.notify('task_failed', {
          issueId: opts.issueId,
          runId: opts.runId,
          message: 'run failed to start',
        });
      } catch (notifyErr) {
        console.error('push notify failed', { kind: 'task_failed', runId: opts.runId, err: notifyErr });
      }
    }
    return { kind: 'spawnFailed', error };
  }

  const { sessionId, exitCode } = await handle.done;

  // If the run ended while a response was still pending, release it so the
  // HTTP route doesn't hang on a Promise nobody will ever resolve.
  if (opts.pendingApprovals) {
    opts.pendingApprovals.cancel(opts.issueId, 'run_finished');
  }

  // Persist session_id BEFORE finishRun so the next resume works (see heartbeat plan deviation).
  if (sessionId) {
    await opts.db.update(issues).set({ currentSessionId: sessionId }).where(eq(issues.id, opts.issueId)).run();
  }

  await finishRun(opts.db, opts.runId, exitCode === 0 ? 'done' : 'failed');
  opts.broadcast({ kind: 'run.finished', runId: opts.runId, issueId: opts.issueId, exit_code: exitCode });
  if (opts.notify) {
    try {
      await opts.notify(exitCode === 0 ? 'task_done' : 'task_failed', {
        issueId: opts.issueId,
        runId: opts.runId,
        message: exitCode === 0 ? 'run completed' : 'run failed',
      });
    } catch (notifyErr) {
      console.error('push notify failed', { kind: exitCode === 0 ? 'task_done' : 'task_failed', runId: opts.runId, err: notifyErr });
    }
  }

  return { kind: 'ok', sessionId, exitCode };
}

export interface StartLoopOpts {
  db: Db;
  adapter: ClaudeAdapter;
  broadcast: (msg: RouteEvent) => void;
  intervalMs?: number;
  /**
   * Optional best-effort push notification hook forwarded to each `runOnce`.
   * Wrapped in try/catch inside the runner so a failing notify never breaks
   * the run flow.
   */
  notify?: (kind: NotifyKind, payload: NotifyPayload) => Promise<void>;
  /**
   * Forwarded to each `runOnce` so approval_request events can pause the
   * runner until the user responds.
   */
  pendingApprovals?: PendingApprovals;
}

/**
 * Start a polling loop that claims the oldest queued run, dispatches it via the
 * adapter, and persists events. Returns a stop function that cancels the interval.
 */
export function startLoop(opts: StartLoopOpts): () => void {
  const interval = opts.intervalMs ?? 1000;
  const tick = async () => {
    try {
      const next = await claimNextRun(opts.db);
      if (!next) return;
      const issue = await opts.db.select().from(issues).where(eq(issues.id, next.issueId)).get();
      if (!issue) {
        await finishRun(opts.db, next.id, 'failed', 'issue_not_found');
        return;
      }
      await runOnce({
        db: opts.db,
        runId: next.id,
        issueId: next.issueId,
        adapter: opts.adapter,
        broadcast: opts.broadcast,
        notify: opts.notify,
        pendingApprovals: opts.pendingApprovals,
      });
    } catch (e) {
      console.error('loop tick failed:', e);
    }
  };
  const handle = setInterval(tick, interval);
  return () => clearInterval(handle);
}