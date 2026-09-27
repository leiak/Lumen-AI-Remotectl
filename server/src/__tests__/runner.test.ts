import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runOnce, startLoop } from '../scheduler/runner.js';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { issues, comments, runs, runEvents } from '../db/schema.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

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
      adapter: makeFakeAdapter([{ type: 'session_start', session_id: 'x' }]),
      binary: process.execPath,
      baseArgs: [await writeFakeScript()],
      workspacePath: '/tmp',
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
      ]),
      binary: process.execPath,
      baseArgs: [await writeFakeScript()],
      workspacePath: os.tmpdir(),
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
      binary: process.execPath,
      baseArgs: [await writeFakeScript()],
      broadcast: bc,
      intervalMs: 50,
    });

    // wait up to 1s for the run to be claimed
    await new Promise((r) => setTimeout(r, 200));
    stop();

    const allRuns = await db.select().from(runs).all();
    expect(allRuns.find((r) => r.issueId === issueId)?.status).toBe('done');
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
  } as any;
}

async function writeFakeScript(): Promise<string> {
  const p = path.join(os.tmpdir(), `fake-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(p, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'session_start',session_id:'x'}) + '\\n');`);
  return p;
}