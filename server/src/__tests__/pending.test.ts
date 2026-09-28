import { describe, it, expect } from 'vitest';
import { PendingApprovals } from '../scheduler/pending.js';

describe('PendingApprovals', () => {
  it('register then respond resolves the promise with the value', async () => {
    const p = new PendingApprovals();
    const promise = new Promise<'yes' | 'no'>((resolve, reject) => {
      p.register('issue-1', { runId: 'r1', resolve, reject, createdAt: Date.now() });
    });
    expect(p.size()).toBe(1);
    expect(p.respond('issue-1', 'yes')).toBe(true);
    expect(p.size()).toBe(0);
    await expect(promise).resolves.toBe('yes');
  });

  it('respond returns false when there is no pending approval', () => {
    const p = new PendingApprovals();
    expect(p.respond('nonexistent', 'no')).toBe(false);
  });

  it('register supersedes a prior pending approval for the same issue', async () => {
    const p = new PendingApprovals();
    const first = new Promise<'yes' | 'no'>((resolve, reject) => {
      p.register('issue-1', { runId: 'r1', resolve, reject, createdAt: Date.now() });
    });
    const second = new Promise<'yes' | 'no'>((resolve, reject) => {
      p.register('issue-1', { runId: 'r2', resolve, reject, createdAt: Date.now() });
    });
    expect(p.size()).toBe(1);
    // The first registration should have been rejected (so the runner can
    // bail out of its await instead of hanging on a phantom promise).
    await expect(first).rejects.toThrow(/superseded/);
    expect(p.respond('issue-1', 'no')).toBe(true);
    await expect(second).resolves.toBe('no');
  });

  it('cancel rejects the pending approval with the given reason', async () => {
    const p = new PendingApprovals();
    const promise = new Promise<'yes' | 'no'>((resolve, reject) => {
      p.register('issue-1', { runId: 'r1', resolve, reject, createdAt: Date.now() });
    });
    p.cancel('issue-1', 'run_finished');
    await expect(promise).rejects.toThrow(/run_finished/);
    expect(p.size()).toBe(0);
  });

  it('clear rejects every pending approval', async () => {
    const p = new PendingApprovals();
    const a = new Promise<'yes' | 'no'>((resolve, reject) => {
      p.register('a', { runId: 'r1', resolve, reject, createdAt: Date.now() });
    });
    const b = new Promise<'yes' | 'no'>((resolve, reject) => {
      p.register('b', { runId: 'r2', resolve, reject, createdAt: Date.now() });
    });
    expect(p.size()).toBe(2);
    p.clear('server_shutdown');
    expect(p.size()).toBe(0);
    await expect(a).rejects.toThrow(/server_shutdown/);
    await expect(b).rejects.toThrow(/server_shutdown/);
  });

  it('has() reports whether an issueId is registered', () => {
    const p = new PendingApprovals();
    expect(p.has('i')).toBe(false);
    p.register('i', { runId: 'r', resolve: () => {}, reject: () => {}, createdAt: 0 });
    expect(p.has('i')).toBe(true);
    p.respond('i', 'yes');
    expect(p.has('i')).toBe(false);
  });
});