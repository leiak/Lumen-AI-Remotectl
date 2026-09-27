import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues, runs, runEvents, comments } from '../db/schema.js';
import { ClaudeAdapter, type ClaudeEvent } from '../adapter/claude.js';
import { claimNextRun, finishRun } from './heartbeat.js';
import type { RouteEvent } from '../events/translate.js';
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

  let handle: { stdin: { write: (s: string) => void }; done: Promise<{ sessionId: string | null; exitCode: number }> };
  try {
    // Resume if there's a currentSessionId; otherwise fresh.
    const adapterOpts = issue.currentSessionId
      ? { resume: issue.currentSessionId, prompt }
      : { fresh: true, prompt };
    handle = opts.adapter.start(adapterOpts, (evt: ClaudeEvent) => {
      // Persist to run_events (fire and forget — don't block event delivery)
      opts.db.insert(runEvents).values({
        runId: opts.runId,
        stream: evt.type === 'error' ? 'stderr' : 'stdout',
        content: JSON.stringify(evt),
        createdAt: new Date(),
      }).run().catch((e) => console.error('runEvents insert failed:', e));

      if (evt.type === 'approval_request') {
        const cid = crypto.randomUUID();
        // Persist as agent comment so the user can see it on the IssueDetail page
        opts.db.insert(comments).values({
          id: cid,
          issueId: opts.issueId,
          authorType: 'agent',
          body: evt.question,
          kind: 'approval_request',
          createdAt: new Date(),
        }).run().catch((e) => console.error('comments insert failed:', e));
        opts.broadcast({ kind: 'approval.requested', issueId: opts.issueId, commentId: cid });
        return;
      }

      opts.broadcast({ kind: 'run.event', runId: opts.runId, issueId: opts.issueId, event: evt });
    });
  } catch (e) {
    const error = e instanceof Error ? (e.stack ?? e.message) : String(e);
    await finishRun(opts.db, opts.runId, 'failed', error);
    opts.broadcast({ kind: 'run.finished', runId: opts.runId, issueId: opts.issueId, exit_code: -1 });
    return { kind: 'spawnFailed', error };
  }

  const { sessionId, exitCode } = await handle.done;

  // Persist session_id BEFORE finishRun so the next resume works (see heartbeat plan deviation).
  if (sessionId) {
    await opts.db.update(issues).set({ currentSessionId: sessionId }).where(eq(issues.id, opts.issueId)).run();
  }

  await finishRun(opts.db, opts.runId, exitCode === 0 ? 'done' : 'failed');
  opts.broadcast({ kind: 'run.finished', runId: opts.runId, issueId: opts.issueId, exit_code: exitCode });

  return { kind: 'ok', sessionId, exitCode };
}

export interface StartLoopOpts {
  db: Db;
  adapter: ClaudeAdapter;
  broadcast: (msg: RouteEvent) => void;
  intervalMs?: number;
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
      });
    } catch (e) {
      console.error('loop tick failed:', e);
    }
  };
  const handle = setInterval(tick, interval);
  return () => clearInterval(handle);
}