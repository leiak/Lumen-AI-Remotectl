import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { enqueueHeartbeat, claimNextRun, finishRun } from '../scheduler/heartbeat.js';
import { issues, comments, runs } from '../db/schema.js';
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
});