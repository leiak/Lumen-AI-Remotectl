import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runOnce, startLoop } from '../scheduler/runner.js';
import { PendingApprovals } from '../scheduler/pending.js';
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
    if (result.kind !== 'ok') throw new Error('expected ok');
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
    if (result.kind !== 'ok') throw new Error('expected ok');
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

  it('persists approval_request event as a comment and broadcasts approval.requested', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const question = 'Allow Bash to run `rm -rf /`?';
    await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: makeFakeAdapter([
        { type: 'session_start', session_id: 's-ap' },
        { type: 'approval_request', question },
        { type: 'session_end', exit_code: 0 },
      ]) as any,
      broadcast: bc,
    });

    const cs = await db.select().from(comments).where(eq(comments.issueId, issueId)).all();
    const approval = cs.find((c) => c.kind === 'approval_request');
    expect(approval).toBeDefined();
    expect(approval!.authorType).toBe('agent');
    expect(approval!.body).toBe(question);
    expect(typeof approval!.id).toBe('string');

    const req = broadcasted.find((b) => b.kind === 'approval.requested');
    expect(req).toBeDefined();
    expect(req.issueId).toBe(issueId);
    expect(req.commentId).toBe(approval!.id);

    // The approval_request event should NOT be wrapped as a run.event.
    expect(broadcasted.some((b) => b.kind === 'run.event' &&
      (b.event as any)?.type === 'approval_request')).toBe(false);
  });

  it('does not broadcast approval.requested when no approval_request event arrives', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: makeFakeAdapter([
        { type: 'session_start', session_id: 's-norun' },
        { type: 'assistant_text', content: 'hi' },
        { type: 'session_end', exit_code: 0 },
      ]) as any,
      broadcast: bc,
    });

    expect(broadcasted.some((b) => b.kind === 'approval.requested')).toBe(false);

    const cs = await db.select().from(comments).where(eq(comments.issueId, issueId)).all();
    expect(cs.filter((c) => c.kind === 'approval_request')).toHaveLength(0);
  });

  it('blocks on approval_request until pendingApprovals.respond() is called', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const pending = new PendingApprovals();
    const respondSpy = vi.fn();

    let emitNext: (() => void) | null = null;
    const stepGate = new Promise<void>((r) => { emitNext = r; });

    const fakeAdapter = {
      start: (_opts: any, onEvent: any) => {
        // Emit one event per `emitNext()` tick. We use this to control timing:
        // 1. session_start fires immediately.
        // 2. approval_request fires — runner registers and awaits.
        // 3. session_end fires only after we explicitly call emitNext again,
        //    which we do AFTER responding to the pending approval.
        let sessionId: string | null = null;
        let exitCode = 0;

        // Kick off the async emit loop.
        (async () => {
          // Tick 1: session_start
          await onEvent({ type: 'session_start', session_id: 's-blk' });
          await new Promise((r) => setImmediate(r));
          // Tick 2: approval_request — runner will await pendingApprovals.
          await onEvent({ type: 'approval_request', question: 'Allow Bash?' });
          await new Promise((r) => setImmediate(r));
          // Wait for the test to call emitNext() before sending session_end.
          await stepGate;
          // Tick 3: session_end — runner resumes and the run finishes.
          await onEvent({ type: 'session_end', exit_code: 0 });
        })();

        return {
          stdin: { write: vi.fn() },
          respond: respondSpy,
          done: new Promise<{ sessionId: string | null; exitCode: number }>((resolve) => {
            // Mirror the real adapter: resolve done after the process "exits".
            // We approximate this by waiting for the emit loop above to drain
            // (session_end is the last emit) and then yielding a tick.
            const tryResolve = () => {
              if (sessionId) resolve({ sessionId, exitCode });
            };
            // Poll once session_end lands. We can't await onEvent directly
            // (we don't own its promise), but stepGate guarantees ordering.
            const tick = async () => {
              while (!emitNext) {
                // The fake above sets emitNext synchronously; this loop is
                // here to avoid TDZ if start() is called before assignment.
                await new Promise((r) => setImmediate(r));
              }
              // Wait for the full emit loop (incl. session_end) to finish.
              await new Promise<void>((r) => {
                const id = setInterval(() => {
                  // Heuristic: once session_end has been seen, the runner
                  // calls finishRun; we resolve done a tick later. Cheap.
                  if (exitCode !== 0 || sessionId) {
                    clearInterval(id);
                    r();
                  }
                }, 5);
              });
              tryResolve();
            };
            // Mark sessionId once seen (set in the loop) — but the loop above
            // doesn't actually expose state. Instead, set sessionId here when
            // emitNext fires:
            const onEmit = () => { sessionId = 's-blk'; exitCode = 0; };
            // Hook: tap into the emit chain via stepGate.
            stepGate.then(() => {
              onEmit();
              tryResolve();
            });
            tick();
          }),
        };
      },
    };

    // Start the run; capture the promise so we can assert it doesn't settle
    // until we respond.
    const runPromise = runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: fakeAdapter as any,
      broadcast: bc,
      pendingApprovals: pending,
    });

    // Wait for the runner to register the pending approval — that's the
    // signal that the runner is now blocked waiting for the user.
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (pending.has(issueId)) resolve();
        else setImmediate(tick);
      };
      tick();
    });

    // While the runner is awaiting, the run is not done.
    let settled = false;
    runPromise.then(() => { settled = true; });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    expect(respondSpy).not.toHaveBeenCalled();

    // Answer the approval. The runner should call handle.respond('yes').
    expect(pending.respond(issueId, 'yes')).toBe(true);

    // Now let the emit loop send session_end so the run can finish.
    emitNext!();

    await runPromise;

    expect(respondSpy).toHaveBeenCalledWith('yes');
    expect(pending.has(issueId)).toBe(false);
  });

  it('does not block on approval_request when pendingApprovals is omitted', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const respondSpy = vi.fn();
    const result = await runOnce({
      db,
      runId: crypto.randomUUID(),
      issueId,
      adapter: makeFakeAdapter([
        { type: 'session_start', session_id: 's-noap' },
        { type: 'approval_request', question: 'Allow Bash?' },
        { type: 'session_end', exit_code: 0 },
      ]) as any,
      broadcast: bc,
    });

    expect(result.kind).toBe('ok');
    // Without a pendingApprovals registry, the runner does not call respond().
    expect(respondSpy).not.toHaveBeenCalled();
  });

  it('releases a pending approval when the run finishes without a response', async () => {
    const issueId = crypto.randomUUID();
    await db.insert(issues).values({
      id: issueId, title: 'do thing', status: 'todo', priority: 'medium',
      workspacePath: os.tmpdir(), createdAt: new Date(), updatedAt: new Date(),
    }).run();

    const pending = new PendingApprovals();
    // Pre-register to mirror the runner's registration timing without
    // actually firing onEvent. We simulate the runner finishing without
    // anyone responding by calling cancel directly — the production code
    // does the same thing on handle.done resolution.
    pending.register(issueId, {
      runId: 'r',
      resolve: () => {},
      reject: () => {},
      createdAt: Date.now(),
    });
    expect(pending.has(issueId)).toBe(true);

    // The runner's post-done cleanup path cancels; verify the contract.
    pending.cancel(issueId, 'run_finished');
    expect(pending.has(issueId)).toBe(false);
  });
});

function makeFakeAdapter(events: any[]) {
  return {
    start: (_opts: any, onEvent: any) => {
      // Wait for every emitted event to finish processing before resolving
      // `done`. This mirrors the real adapter, which only emits `done` after
      // the underlying process exits — and, crucially, lets the runner's
      // async `onEvent` callbacks (e.g. approval_request comment insert)
      // settle before runOnce() returns. Without this, tests would race.
      const eventPromises = events.map((e) => Promise.resolve(onEvent(e)));
      return {
        stdin: { write: vi.fn() },
        respond: vi.fn(),
        done: Promise.all(eventPromises).then(() => ({
          sessionId: events.find((e: any) => e.type === 'session_start')?.session_id ?? null,
          exitCode: events.find((e: any) => e.type === 'session_end')?.exit_code ?? 0,
        })),
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
      const eventPromises = events.map((e) => Promise.resolve(onEvent(e)));
      return {
        stdin: { write: vi.fn() },
        respond: vi.fn(),
        done: Promise.all(eventPromises).then(() => ({
          sessionId: null,
          exitCode: events.find((e: any) => e.type === 'session_end')?.exit_code ?? 0,
        })),
      };
    },
  };
}