import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { enqueueHeartbeat, claimNextRun, finishRun } from '../scheduler/heartbeat.js';
import { issues, runs } from '../db/schema.js';
import { eq } from 'drizzle-orm';

describe('scheduler', () => {
  let dbPath: string;
  let db: ReturnType<typeof createDb>;
  let issueId: string;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `sched-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createDb(dbPath);
    await migrate(db);

    issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 't', status: 'todo',
      priority: 'low', workspacePath: '/x',
      createdAt: new Date(), updatedAt: new Date(),
    }).run();
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('enqueueHeartbeat creates a queued run', async () => {
    const runId = await enqueueHeartbeat(db, issueId, 'on_comment');
    const row = await db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(row?.status).toBe('queued');
    expect(row?.trigger).toBe('on_comment');
  });

  it('claimNextRun atomically moves queued to running', async () => {
    await enqueueHeartbeat(db, issueId, 'on_comment');
    await enqueueHeartbeat(db, issueId, 'on_comment');
    const claimed = await claimNextRun(db);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('running');
    expect(claimed!.startedAt).toBeInstanceOf(Date);
  });

  it('claimNextRun returns null when no queued runs', async () => {
    const claimed = await claimNextRun(db);
    expect(claimed).toBeNull();
  });

  it('does not enqueue heartbeat for cancelled issue', async () => {
    await db.update(issues).set({ status: 'cancelled' }).where(eq(issues.id, issueId)).run();
    await expect(enqueueHeartbeat(db, issueId, 'on_comment')).rejects.toThrow();
  });

  it('finishRun updates status and finishedAt', async () => {
    const runId = await enqueueHeartbeat(db, issueId, 'manual');
    await finishRun(db, runId, 'done');
    const row = await db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(row?.status).toBe('done');
    expect(row?.finishedAt).toBeInstanceOf(Date);
  });

  it('claimNextRun returns oldest queued run first (FIFO)', async () => {
    const r1 = await enqueueHeartbeat(db, issueId, 'on_comment');
    await new Promise(r => setTimeout(r, 10));
    const r2 = await enqueueHeartbeat(db, issueId, 'on_comment');
    const claimed = await claimNextRun(db);
    expect(claimed?.id).toBe(r1);
    expect(claimed?.id).not.toBe(r2);
  });

  it('claimNextRun does not return the same run to two concurrent callers', async () => {
    await enqueueHeartbeat(db, issueId, 'on_comment');
    await enqueueHeartbeat(db, issueId, 'on_comment');
    const [a, b] = await Promise.all([claimNextRun(db), claimNextRun(db)]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it('finishRun is no-op on already-terminal run', async () => {
    const runId = await enqueueHeartbeat(db, issueId, 'manual');
    await finishRun(db, runId, 'done');
    // Second finishRun should not error and should not change status/finishedAt
    await finishRun(db, runId, 'cancelled');
    const row = await db.select().from(runs).where(eq(runs.id, runId)).get();
    expect(row?.status).toBe('done');
  });

  it('enqueueHeartbeat throws on unknown issue', async () => {
    await expect(enqueueHeartbeat(db, crypto.randomUUID(), 'manual')).rejects.toThrow('issue_not_found');
  });
});
