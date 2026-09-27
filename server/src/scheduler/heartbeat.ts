import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues, runs } from '../db/schema.js';

export async function enqueueHeartbeat(db: Db, issueId: string, trigger: 'manual' | 'on_comment' | 'on_approval' | 'on_retry'): Promise<string> {
  const issue = await db.select().from(issues).where(eq(issues.id, issueId)).get();
  if (!issue) throw new Error('issue_not_found');
  if (issue.status === 'cancelled') throw new Error('issue_cancelled');

  const id = crypto.randomUUID();
  await db.insert(runs).values({
    id, issueId, status: 'queued', trigger,
  }).run();
  return id;
}

export async function claimNextRun(db: Db) {
  const next = await db.select().from(runs).where(eq(runs.status, 'queued')).limit(1).get();
  if (!next) return null;
  const now = new Date();
  await db.update(runs)
    .set({ status: 'running', startedAt: now })
    .where(eq(runs.id, next.id))
    .run();
  return { ...next, status: 'running' as const, startedAt: now };
}

export async function finishRun(db: Db, runId: string, status: 'done' | 'failed' | 'cancelled', error?: string) {
  await db.update(runs)
    .set({ status, finishedAt: new Date(), error: error ?? null })
    .where(eq(runs.id, runId))
    .run();
}