import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues, runs } from '../db/schema.js';

export type RunRow = typeof runs.$inferSelect;

export async function enqueueHeartbeat(db: Db, issueId: string, trigger: 'manual' | 'on_comment' | 'on_approval' | 'on_retry'): Promise<string> {
  const issue = await db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) throw new Error('issue_not_found');
  if (issue.status === 'cancelled') throw new Error('issue_cancelled');

  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(runs).values({
    id, issueId, status: 'queued', trigger,
    createdAt: now,
  }).run();
  return id;
}

export async function claimNextRun(db: Db): Promise<RunRow | null> {
  // Atomically claim the oldest queued run. The status guard in the UPDATE
  // WHERE clause prevents two concurrent callers from claiming the same row;
  // on a race we retry the SELECT to grab the next queued run.
  for (let attempt = 0; attempt < 100; attempt++) {
    const oldest = await db.select().from(runs)
      .where(eq(runs.status, 'queued'))
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(1).get();
    if (!oldest) return null;
    const now = new Date();
    const updated = await db.update(runs)
      .set({ status: 'running', startedAt: now })
      .where(and(eq(runs.id, oldest.id), eq(runs.status, 'queued')))
      .returning()
      .all();
    if (updated.length === 1) {
      return { ...updated[0], status: 'running' as const, startedAt: now };
    }
    // else: another caller claimed this row between our SELECT and UPDATE — retry
  }
  return null;
}

export async function finishRun(db: Db, runId: string, status: 'done' | 'failed' | 'cancelled', error?: string) {
  const existing = await db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!existing) throw new Error('run_not_found');
  if (existing.status === 'done' || existing.status === 'failed' || existing.status === 'cancelled') {
    // already terminal — no-op to keep finishRun idempotent
    return;
  }
  await db.update(runs)
    .set({ status, finishedAt: new Date(), error: error ?? null })
    .where(eq(runs.id, runId))
    .run();
}
