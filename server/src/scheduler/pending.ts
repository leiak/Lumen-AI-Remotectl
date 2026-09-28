/**
 * Tracks approval requests that are awaiting a user response from the phone.
 *
 * When the runner sees a `tool_use` it considers dangerous (or the underlying
 * Claude process explicitly emits `approval_request`), it registers a pending
 * entry here. The HTTP route, on receiving an `approval_response` comment,
 * looks up the entry by `issueId` and forwards the user's yes/no to the
 * awaiting runner via the `resolve` callback.
 *
 * Only one pending approval per issueId is supported — the runner claims runs
 * sequentially via `claimNextRun`, so two simultaneous runs against the same
 * issue can't happen.
 */
export interface PendingApproval {
  runId: string;
  /** Resolves with 'yes' or 'no' when the user responds. */
  resolve: (value: 'yes' | 'no') => void;
  /** Rejects if the approval is cancelled (run ended, server shutdown). */
  reject: (err: Error) => void;
  /** Wall-clock timestamp of registration (ms since epoch). Useful for debugging
   *  stale entries that survived a runner crash. */
  createdAt: number;
}

export class PendingApprovals {
  private map = new Map<string, PendingApproval>();

  /**
   * Register a new pending approval. Overwrites any existing entry for the
   * same issueId (the older entry is rejected so we never strand a runner).
   */
  register(issueId: string, entry: PendingApproval): void {
    const existing = this.map.get(issueId);
    if (existing) {
      this.map.delete(issueId);
      existing.reject(new Error('superseded_by_new_approval'));
    }
    this.map.set(issueId, entry);
  }

  /**
   * Resolve the pending approval for issueId. Returns true if a pending entry
   * existed (and was resolved), false if there was nothing to resolve — e.g.
   * the user responded after the run already finished, or the response is a
   * duplicate of an earlier one. Callers should treat `false` as "not an
   * error, just nothing to do."
   */
  respond(issueId: string, value: 'yes' | 'no'): boolean {
    const entry = this.map.get(issueId);
    if (!entry) return false;
    this.map.delete(issueId);
    entry.resolve(value);
    return true;
  }

  /**
   * Reject the pending approval, e.g. on run failure or shutdown.
   */
  cancel(issueId: string, reason = 'approval_cancelled'): void {
    const entry = this.map.get(issueId);
    if (!entry) return;
    this.map.delete(issueId);
    entry.reject(new Error(reason));
  }

  /**
   * Reject every pending entry. Used by graceful shutdown so the runner's
   * `await pendingPromise` can unblock with an error instead of hanging.
   */
  clear(reason = 'server_shutdown'): void {
    for (const [issueId, entry] of this.map) {
      this.map.delete(issueId);
      entry.reject(new Error(reason));
    }
  }

  has(issueId: string): boolean {
    return this.map.has(issueId);
  }

  size(): number {
    return this.map.size;
  }
}