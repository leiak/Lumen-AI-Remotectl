import { describe, it, expect, vi } from 'vitest';
import { broadcastToWs } from '../events/translate.js';
import type { BroadcastHub } from '../ws/broadcast.js';

describe('broadcastToWs translator', () => {
  function makeHub() {
    return { broadcast: vi.fn() } as unknown as BroadcastHub & { broadcast: ReturnType<typeof vi.fn> };
  }

  it('translates run.queued → run_started (preserves WS shape)', () => {
    const hub = makeHub();
    broadcastToWs(hub as any, { kind: 'run.queued', issueId: 'i1', runId: 'r1' });
    expect(hub.broadcast).toHaveBeenCalledWith({
      type: 'run_started', runId: 'r1', issueId: 'i1',
    });
  });

  it('translates run.started → run_started', () => {
    const hub = makeHub();
    broadcastToWs(hub as any, { kind: 'run.started', runId: 'r1', issueId: 'i1' });
    expect(hub.broadcast).toHaveBeenCalledWith({
      type: 'run_started', runId: 'r1', issueId: 'i1',
    });
  });

  it('translates run.event → run_event with JSON-stringified content', () => {
    const hub = makeHub();
    const evt = { type: 'assistant_text', content: 'hi' };
    broadcastToWs(hub as any, { kind: 'run.event', runId: 'r1', issueId: 'i1', event: evt });
    expect(hub.broadcast).toHaveBeenCalledWith({
      type: 'run_event', runId: 'r1', issueId: 'i1', stream: 'stdout',
      content: JSON.stringify(evt),
    });
  });

  it('translates run.finished (exit_code=0) → status=done', () => {
    const hub = makeHub();
    broadcastToWs(hub as any, { kind: 'run.finished', runId: 'r1', issueId: 'i1', exit_code: 0 });
    expect(hub.broadcast).toHaveBeenCalledWith({
      type: 'run_finished', runId: 'r1', issueId: 'i1', status: 'done',
    });
  });

  it('translates run.finished (exit_code!=0) → status=failed', () => {
    const hub = makeHub();
    broadcastToWs(hub as any, { kind: 'run.finished', runId: 'r1', issueId: 'i1', exit_code: 2 });
    expect(hub.broadcast).toHaveBeenCalledWith({
      type: 'run_finished', runId: 'r1', issueId: 'i1', status: 'failed',
    });
  });

  it('translates approval.requested → approval_requested with commentId', () => {
    const hub = makeHub();
    broadcastToWs(hub as any, { kind: 'approval.requested', issueId: 'i1', commentId: 'c1' });
    expect(hub.broadcast).toHaveBeenCalledWith({
      type: 'approval_requested', issueId: 'i1', commentId: 'c1',
    });
  });

  it('translates approval.responded → approval_responded with value', () => {
    const hub = makeHub();
    broadcastToWs(hub as any, { kind: 'approval.responded', issueId: 'i1', value: 'yes' });
    expect(hub.broadcast).toHaveBeenCalledWith({
      type: 'approval_responded', issueId: 'i1', value: 'yes',
    });
  });
});