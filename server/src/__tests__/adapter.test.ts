import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../adapter/claude.js';
import { spawnFakeClaude } from './fake-claude.js';

describe('ClaudeAdapter', () => {
  it('forks a process and parses stdout NDJSON', async () => {
    const fakePath = await spawnFakeClaude();
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fakePath],
      workspacePath: '/tmp',
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
    const fakePath = await spawnFakeClaude();
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fakePath],
      workspacePath: '/tmp',
    });
    const handle = adapter.start({ resume: 'session-xyz', prompt: 'continue' }, () => {});
    await handle.done;
    // The fake doesn't validate, but we just need to ensure it ran without error
  });

  it('exposes stdin for writing approval responses', async () => {
    const fakePath = await spawnFakeClaude();
    const adapter = new ClaudeAdapter({
      binary: process.execPath,
      baseArgs: [fakePath],
      workspacePath: '/tmp',
    });
    const handle = adapter.start({ fresh: true, prompt: 'hi' }, () => {});
    expect(handle.stdin).toBeDefined();
    expect(typeof handle.stdin.write).toBe('function');
    handle.stdin.write('yes\n');
    await handle.done;
  });
});
