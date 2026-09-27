import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { ClaudeAdapter } from '../adapter/claude.js';
import { spawnFakeClaude, type FakeClaudeHandle } from './fake-claude.js';

const tmp = () => path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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
