import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runOnce, startLoop } from '../scheduler/runner.js';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { issues, comments, runs, runEvents } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

describe('runOnce', () => {
  let dbPath: string;
  let db: ReturnType<typeof createDb>;
  const broadcasted: any[] = [];
  const bc = (m: any) => broadcasted.push(m);

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `runner-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = createDb(dbPath);
    await migrate(db);
    broadcasted.length = 0;
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('returns runNotFound when issueId does not exist', async () => {
    const result = await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId: crypto.randomUUID(),
      adapter: makeFakeAdapter([{ type: 'session_start', session_id: 'x' }]) as any,
      broadcast: bc,
    });
    expect(result.kind).toBe('runNotFound');
    expect(broadcasted).toHaveLength(0);
  });

  it('spawns adapter, persists events, and finishes the run', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const result = await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: makeFakeAdapter([
        { type: 'session_start', session_id: 'session-1' },
        { type: 'assistant_text', content: 'hello' },
        { type: 'session_end', exit_code: 0 },
      ]) as any,
      broadcast: bc,
    });

    expect(result.kind).toBe('ok');
    expect(result.sessionId).toBe('session-1');
    expect(result.exitCode).toBe(0);

    const events = await db.select().from(runEvents).all();
    expect(events.length).toBeGreaterThan(0);

    const r = await db.select().from(runs).all();
    expect(r[0].status).toBe('done');

    expect(broadcasted.some((b) => b.kind === 'run.started')).toBe(true);
    expect(broadcasted.some((b) => b.kind === 'run.finished')).toBe(true);
  });

  it('startLoop claims and runs queued runs', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();
    await db.insert(runs).values({
      id: crypto.randomUUID(), issueId, status: 'queued', trigger: 'on_comment',
      createdAt: new Date(),
    }).run();

    const stop = startLoop({
      db,
      adapter: makeFakeAdapter([
        { type: 'session_start', session_id: 's1' },
        { type: 'session_end', exit_code: 0 },
      ]) as any,
      broadcast: bc,
      intervalMs: 50,
    });

    // wait up to 1s for the run to be claimed
    await new Promise((r) => setTimeout(r, 200));
    stop();

    const allRuns = await db.select().from(runs).all();
    expect(allRuns.find((r) => r.issueId === issueId)?.status).toBe('done');
  });

  it('returns spawnFailed and marks run failed when adapter.start throws', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const result = await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: makeFakeAdapterThrow(new Error('boom')) as any,
      broadcast: bc,
    });

    expect(result.kind).toBe('spawnFailed');
    expect((result as any).error).toContain('boom');

    const r = await db.select().from(runs).all();
    expect(r[0].status).toBe('failed');
    expect(r[0].error ?? '').toContain('boom');

    const finished = broadcasted.find((b) => b.kind === 'run.finished');
    expect(finished).toBeDefined();
    expect(finished.exit_code).toBe(-1);
    expect(finished.issueId).toBe(issueId);
  });

  it('persists currentSessionId after a successful run', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const result = await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: makeFakeAdapter([
        { type: 'session_start', session_id: 'new-session' },
        { type: 'session_end', exit_code: 0 },
      ]) as any,
      broadcast: bc,
    });

    expect(result.kind).toBe('ok');
    expect(result.sessionId).toBe('new-session');

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).get();
    expect(issue?.currentSessionId).toBe('new-session');
  });

  it('uses fresh:true when the issue has no currentSessionId', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const captured = { opts: undefined as any };
    const adapter = makeCapturingFakeAdapter(captured, [
      { type: 'session_end', exit_code: 0 },
    ]);

    await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: adapter as any,
      broadcast: bc,
    });

    expect(captured.opts).toBeDefined();
    expect(captured.opts.fresh).toBe(true);
    expect(captured.opts.resume).toBeUndefined();
    expect(typeof captured.opts.prompt).toBe('string');
  });

  it('uses resume:<session> when the issue already has a currentSessionId', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
      currentSessionId: 'old-session',
    }).run();

    const captured = { opts: undefined as any };
    const adapter = makeCapturingFakeAdapter(captured, [
      { type: 'session_end', exit_code: 0 },
    ]);

    await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: adapter as any,
      broadcast: bc,
    });

    expect(captured.opts).toBeDefined();
    expect(captured.opts.resume).toBe('old-session');
    expect(captured.opts.fresh).toBeUndefined();
    expect(typeof captured.opts.prompt).toBe('string');
  });

  it('persists run events in the order they were emitted', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const e1 = { type: 'assistant_text', content: 'one' };
    const e2 = { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } };
    const e3 = { type: 'assistant_text', content: 'three' };

    await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: makeFakeAdapter([
        e1,
        e2,
        e3,
        { type: 'session_end', exit_code: 0 },
      ]) as any,
      broadcast: bc,
    });

    const persisted = await db.select().from(runEvents).all();
    // Filter to the content events (excluding the session_end which is not emitted
    // to onEvent by the adapter contract — it's resolved via done).
    const contentRows = persisted
      .map((r) => JSON.parse(r.content))
      .filter((evt: any) => ['assistant_text', 'tool_use'].includes(evt.type));

    expect(contentRows.length).toBe(3);
    expect(contentRows[0].content).toBe('one');
    expect(contentRows[1].name).toBe('Bash');
    expect(contentRows[2].content).toBe('three');
  });
});

function makeFakeAdapter(events: any[]) {
  return {
    start: (_opts: any, onEvent: any) => {
      for (const e of events) onEvent(e);
      return {
        stdin: { write: vi.fn() },
        done: Promise.resolve({
          sessionId: events.find((e: any) => e.type === 'session_start')?.session_id ?? null,
          exitCode: events.find((e: any) => e.type === 'session_end')?.exit_code ?? 0,
        }),
      };
    },
  };
}

function makeFakeAdapterThrow(err: Error) {
  return {
    start: (_opts: any, _onEvent: any) => {
      throw err;
    },
  };
}

function makeCapturingFakeAdapter(captured: { opts: any }, events: any[]) {
  return {
    start: (opts: any, onEvent: any) => {
      captured.opts = opts;
      for (const e of events) onEvent(e);
      return {
        stdin: { write: vi.fn() },
        done: Promise.resolve({
          sessionId: null,
          exitCode: events.find((e: any) => e.type === 'session_end')?.exit_code ?? 0,
        }),
      };
    },
  };
}