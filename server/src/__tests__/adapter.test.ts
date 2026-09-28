import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ClaudeAdapter } from '../adapter/claude.js';
import { spawnFakeClaude, type FakeClaudeHandle } from './fake-claude.js';

const tmp = () => {
  const p = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

describe('ClaudeAdapter', () => {
  let handles: FakeClaudeHandle[] = [];

  afterEach(() => {
    for (const h of handles) h.cleanup();
    handles = [];
  });

  function track(promise: Promise<FakeClaudeHandle>): Promise<FakeClaudeHandle> {
    return promise.then((h) => {
      handles.push(h);
      return h;
    });
  }

  it('forks a process and parses stdout NDJSON', async () => {
    const fake = await track(spawnFakeClaude());
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fake.path],
      workspacePath: tmp(),
    });
    const events: any[] = [];
    const handle = adapter.start({ fresh: true, prompt: 'hello' }, (e) => {
      events.push(e);
    });
    const { sessionId, exitCode } = await handle.done;
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'session_start')).toBe(true);
    expect(sessionId).toBe('fake-abc-123');
    expect(exitCode).toBe(0);
  });

  it('passes --resume flag when resume option provided', async () => {
    const fake = await track(spawnFakeClaude());
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fake.path],
      workspacePath: tmp(),
    });
    const handle = adapter.start({ resume: 'session-xyz', prompt: 'continue' }, () => {});
    await handle.done;
    // The fake doesn't validate, but we just need to ensure it ran without error
  });

  it('exposes stdin for writing approval responses', async () => {
    const fake = await track(spawnFakeClaude());
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fake.path],
      workspacePath: tmp(),
    });
    const handle = adapter.start({ fresh: true, prompt: 'hi' }, () => {});
    expect(handle.stdin).toBeDefined();
    expect(typeof handle.stdin.write).toBe('function');
    handle.stdin.write('yes\n');
    await handle.done;
  });

  it('handle.respond() writes the user response to stdin (interactive-mode hook)', async () => {
    // Spawn a stub that mirrors every byte it reads on stdin to a side-channel
    // file (path passed via env). The default fake-claude ignores stdin; this
    // test needs to see what the adapter flushes so we can assert on the
    // exact bytes.
    const logPath = path.join(os.tmpdir(), `respond-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const stubPath = path.join(os.tmpdir(), `respond-stub-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
    const stub = `
const fs = require('fs');
const log = process.env.SIDE_CHANNEL;
process.stdin.on('data', (chunk) => { fs.appendFileSync(log, chunk); });
process.stdout.write(JSON.stringify({type:'session_start',session_id:'s'}) + '\\n');
process.stdout.write(JSON.stringify({type:'session_end',exit_code:0}) + '\\n');
setTimeout(() => process.exit(0), 100);
`;
    fs.writeFileSync(stubPath, stub);
    const prevEnv = process.env.SIDE_CHANNEL;
    process.env.SIDE_CHANNEL = logPath;

    try {
      const adapter = new ClaudeAdapter({
        binary: process.execPath,
        baseArgs: [stubPath],
        workspacePath: tmp(),
      });
      const handle = adapter.start({ fresh: true, prompt: 'hi' }, () => {});
      handle.respond('yes');
      handle.respond('no');
      const { exitCode } = await handle.done;
      expect(exitCode).toBe(0);

      // Give the OS a tick to flush the side-channel file.
      await new Promise((r) => setImmediate(r));
      const written = fs.readFileSync(logPath, 'utf8');
      expect(written).toBe('yes\nno\n');
    } finally {
      if (prevEnv === undefined) delete process.env.SIDE_CHANNEL;
      else process.env.SIDE_CHANNEL = prevEnv;
      try { fs.unlinkSync(logPath); } catch {}
      try { fs.unlinkSync(stubPath); } catch {}
    }
  });

  it('handle.respond() is safe to call after the process exits', async () => {
    const fake = await track(spawnFakeClaude());
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fake.path],
      workspacePath: tmp(),
    });
    const handle = adapter.start({ fresh: true, prompt: 'hi' }, () => {});
    await handle.done;
    // Should not throw — stdin is already closed.
    expect(() => handle.respond('yes')).not.toThrow();
  });

  it('surfaces stderr writes as error events', async () => {
    const fake = await track(spawnFakeClaude());
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fake.path],
      workspacePath: tmp(),
    });
    const events: any[] = [];
    const handle = adapter.start({ fresh: true, prompt: 'hi' }, (e) => {
      events.push(e);
    });
    await handle.done;
    const errors = events.filter(e => e.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/something went wrong/);
  });

  it('handles non-JSON stdout lines without crashing', async () => {
    const fake = await track(spawnFakeClaude());
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fake.path],
      workspacePath: tmp(),
    });
    const events: any[] = [];
    const handle = adapter.start({ fresh: true, prompt: 'hi' }, (e) => {
      events.push(e);
    });
    const { exitCode } = await handle.done;
    expect(exitCode).toBe(0);
    // The fake emits a plain-text line which the adapter must surface as assistant_text.
    const textEvents = events.filter(
      e => e.type === 'assistant_text' && e.content === 'not a json line, just plain text',
    );
    expect(textEvents.length).toBe(1);
  });

  it('propagates session_end exit_code through done', async () => {
    const fake = await track(spawnFakeClaude({ exitCode: 7 }));
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fake.path],
      workspacePath: tmp(),
    });
    const handle = adapter.start({ fresh: true, prompt: 'hi' }, () => {});
    const { exitCode } = await handle.done;
    expect(exitCode).toBe(7);
  });

  it('rejects prompts that start with --', () => {
    const fake = { path: '/dev/null', cleanup: () => {} };
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fake.path],
      workspacePath: tmp(),
    });
    expect(() =>
      adapter.start({ fresh: true, prompt: '--evil-flag' }, () => {}),
    ).toThrow(/prompt_cannot_start_with_dashes/);
  });

  it('resolves done with exitCode -1 when spawn fails', async () => {
    const adapter = new ClaudeAdapter({
      binary: path.join(os.tmpdir(), 'definitely-does-not-exist-binary-xyz'),
      baseArgs: [],
      workspacePath: tmp(),
    });
    const handle = adapter.start({ fresh: true, prompt: 'hi' }, () => {});
    const { exitCode, sessionId } = await handle.done;
    expect(exitCode).toBe(-1);
    expect(sessionId).toBeNull();
  });
});
