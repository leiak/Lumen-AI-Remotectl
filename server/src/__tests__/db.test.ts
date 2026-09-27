import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { issues, comments, runs, runEvents } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

describe('db', () => {
  let dbPath: string;
  let db: ReturnType<typeof createDb>;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createDb(dbPath);
    await migrate(db);
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('creates an issue and reads it back', async () => {
    const id = crypto.randomUUID();
    await db.insert(issues).values({
      id,
      title: 'fix login bug',
      status: 'todo',
      priority: 'medium',
      workspacePath: '/tmp/repo',
      createdAt: new Date(),
      updatedAt: new Date(),
    }).run();

    const rows = await db.select().from(issues).where(eq(issues.id, id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('fix login bug');
  });

  it('inserts a user comment', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'test', status: 'in_progress',
      priority: 'low', workspacePath: '/tmp',
      createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const commentId = crypto.randomUUID();
    await db.insert(comments).values({
      id: commentId, issueId, authorType: 'user',
      body: 'continue', kind: 'message',
      createdAt: new Date(),
    }).run();

    const rows = await db.select().from(comments).where(eq(comments.issueId, issueId)).all();
    expect(rows[0].authorType).toBe('user');
  });

  it('run_events id is auto-increment and ordered', async () => {
    const runId = crypto.randomUUID();
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 't', status: 'in_progress', priority: 'low',
      workspacePath: '/x', createdAt: new Date(), updatedAt: new Date(),
    }).run();
    await db.insert(runs).values({
      id: runId, issueId, status: 'running', trigger: 'manual',
    }).run();

    await db.insert(runEvents).values({ runId, stream: 'stdout', content: 'line 1', createdAt: new Date() }).run();
    await db.insert(runEvents).values({ runId, stream: 'stdout', content: 'line 2', createdAt: new Date() }).run();
    await db.insert(runEvents).values({ runId, stream: 'stdout', content: 'line 3', createdAt: new Date() }).run();

    const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(runEvents.id).all();
    expect(rows.map(r => r.content)).toEqual(['line 1', 'line 2', 'line 3']);
    expect(rows[0].id).toBeLessThan(rows[1].id);
  });

  it('cascade deletes comments, runs, and run_events when issue is deleted', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 't', status: 'todo', priority: 'low',
      workspacePath: '/x', createdAt: new Date(), updatedAt: new Date(),
    }).run();
    const runId = crypto.randomUUID();
    await db.insert(runs).values({ id: runId, issueId, status: 'running', trigger: 'manual' }).run();
    await db.insert(comments).values({
      id: crypto.randomUUID(), issueId, authorType: 'user', body: 'c', kind: 'message', createdAt: new Date(),
    }).run();
    await db.insert(runEvents).values({ runId, stream: 'stdout', content: 'e', createdAt: new Date() }).run();

    await db.delete(issues).where(eq(issues.id, issueId)).run();

    expect(await db.select().from(comments).where(eq(comments.issueId, issueId)).all()).toHaveLength(0);
    expect(await db.select().from(runs).where(eq(runs.issueId, issueId)).all()).toHaveLength(0);
    expect(await db.select().from(runEvents).where(eq(runEvents.runId, runId)).all()).toHaveLength(0);
  });

  it('migrate is idempotent (safe to call twice)', async () => {
    await migrate(db); // call again — should not throw
    const id = crypto.randomUUID();
    await db.insert(issues).values({
      id, title: 'after second migrate', status: 'todo', priority: 'low',
      workspacePath: '/x', createdAt: new Date(), updatedAt: new Date(),
    }).run();
    const rows = await db.select().from(issues).where(eq(issues.id, id)).all();
    expect(rows).toHaveLength(1);
  });
});
