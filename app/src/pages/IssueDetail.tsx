import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import type { Issue, Comment, BroadcastEvent } from '../api/types';
import { ApprovalCard } from '../components/ApprovalCard';
import { WsClient } from '../ws';
import { storage } from '../storage';
import { toast } from '../components/ConnectionBanner';

// How long the inline "Delete?" prompt waits before reverting to ×.
// Long enough for a deliberate double-tap, short enough that a stray tap
// doesn't leave the page in a half-decoded state for the rest of the session.
const PENDING_TIMEOUT_MS = 4000;

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Track which comment is currently being deleted so the × button can show
  // a busy state and we don't double-fire if the user mashes it.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Two-step delete: first tap arms the comment (shows "Delete?" + Cancel);
  // second tap within `PENDING_TIMEOUT_MS` commits the delete. We deliberately
  // avoid `window.confirm()` because on iOS Safari the native dialog can leave
  // the page in a briefly-unresponsive state, after which subsequent taps are
  // silently dropped — that was the root cause of "only the first delete
  // works". An inline two-step is fully event-loop-driven, so we never leave
  // the page in a half-decoded state.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [iss, cmts] = await Promise.all([api.getIssue(id), api.listComments(id)]);
      setError(null);
      setIssue(iss);
      setComments(cmts);
    } catch (e) {
      setError(fmtError(e));
    }
  }, [api, id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setIssue(null);
    setComments(null);
    setError(null);
    Promise.all([api.getIssue(id), api.listComments(id)])
      .then(([iss, cmts]) => {
        if (cancelled) return;
        setError(null);
        setIssue(iss);
        setComments(cmts);
      })
      .catch((e) => { if (!cancelled) setError(fmtError(e)); });
    return () => { cancelled = true; };
  }, [api, id]);

  // Live updates via WebSocket. Filter on `issueId` so a user looking at
  // Issue A doesn't see Issue B's status changes ripple through here.
  // `run_event` is excluded: it's a stream-level event fired per stdout/stderr
  // chunk during an active run, captured by LiveStream — it doesn't change
  // issue or comments state, so reloading here would just hammer the API and
  // cause page flicker.
  useEffect(() => {
    if (!id) return;
    if (!storage.getHost() || !storage.getApiKey()) return;

    let cancelled = false;
    const ws = new WsClient({ baseBackoffMs: 1000, maxBackoffMs: 30_000 });
    const unsub = ws.onMessage((msg: BroadcastEvent) => {
      if (cancelled) return;
      // Defensive guard: WsClient emits whatever the WS sends. Treat malformed
      // frames (null, non-objects, missing fields) as no-ops rather than
      // throwing — the page should remain interactive even on bad input.
      if (!msg || typeof msg !== 'object') return;
      // Filter events for other issues. Now that `run_finished` carries
      // `issueId` server-side, the filter is strict for every event type.
      if (typeof msg.issueId === 'string' && msg.issueId !== id) return;
      switch (msg.type) {
        case 'run_started':
        case 'run_finished':
        case 'issue_updated':
        case 'approval_requested':
        case 'approval_responded':
        case 'comment_deleted':
          load();
          break;
      }
    });
    ws.connect();

    return () => {
      cancelled = true;
      unsub();
      ws.disconnect();
    };
  }, [id, load]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!id || !comments) return;
    if (!canSend) return;
    setSubmitting(true);
    try {
      const c = await api.addComment(id, { body: draft.trim() });
      setComments((prev) => (prev ? [...prev, c] : [c]));
      setDraft('');
    } catch (e) {
      setError(fmtError(e));
      toast(`Send failed: ${fmtError(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  const canSend = !!id && !!draft.trim() && !submitting;

  async function onDelete(commentId: string) {
    if (!id || deletingId) return;
    // Two-step delete: first tap arms, second tap commits. The first tap
    // shows inline "Delete?" + Cancel in place of ×; tapping Delete? again
    // (or Enter on a keyboard) within PENDING_TIMEOUT_MS commits.
    //
    // Why not window.confirm(): the native dialog briefly takes the page off
    // the JS event loop on iOS Safari, and taps issued in the recovery
    // window can be silently lost. Inline confirmation stays inside the
    // event loop so the next tap is guaranteed to fire.
    if (pendingDeleteId !== commentId) {
      // Arm this comment. If another was previously armed, switch directly.
      clearPendingTimer();
      setPendingDeleteId(commentId);
      pendingTimerRef.current = window.setTimeout(() => {
        pendingTimerRef.current = null;
        setPendingDeleteId(null);
      }, PENDING_TIMEOUT_MS);
      return;
    }
    // Already armed — commit.
    clearPendingTimer();
    setPendingDeleteId(null);
    setDeletingId(commentId);
    try {
      await api.deleteComment(id, commentId);
      // Optimistically remove from local state so the UI is snappy; the
      // WS-driven `load()` will reconcile when the broadcast lands.
      setComments((prev) => (prev ? prev.filter((c) => c.id !== commentId) : prev));
    } catch (e) {
      toast(`Delete failed: ${fmtError(e)}`);
    } finally {
      setDeletingId(null);
    }
  }

  function cancelPendingDelete() {
    clearPendingTimer();
    setPendingDeleteId(null);
  }

  function clearPendingTimer() {
    if (pendingTimerRef.current !== null) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }

  // Drop any pending timer on unmount so we don't try to setState on a
  // torn-down component. Also drop on route change (id swap) so a stale
  // confirmation doesn't follow the user to a different issue.
  useEffect(() => {
    return () => clearPendingTimer();
  }, [id]);

  if (!id) return <div className="page issue-detail"><h2>Issue</h2><p>Missing id.</p></div>;
  if (error) return <div className="page issue-detail error">Error: {error}</div>;
  if (!issue || !comments) return <div className="page issue-detail loading">Loading…</div>;

  return (
    <div className="page issue-detail">
      <h2>{issue.title}</h2>
      {issue.status === 'in_progress' && (
        <Link to={`/issues/${id}/stream`} className="live-stream-link">
          📺 Live stream
        </Link>
      )}
      <div className="meta">
        <span className={`badge badge-${issue.status}`}>{issue.status}</span>
        <span className={`badge badge-priority-${issue.priority}`}>{issue.priority}</span>
        <code className="workspace">{issue.workspacePath}</code>
      </div>
      <ul className="comments">
        {comments.map((c) => {
          if (c.kind === 'approval_request') {
            return (
              <ApprovalCard
                key={c.id}
                issueId={id!}
                commentId={c.id}
                body={c.body}
                onResolved={load}
              />
            );
          }
          const isPending = pendingDeleteId === c.id && deletingId !== c.id;
          return (
            <li key={c.id} className={`comment comment-${c.authorType} ${c.kind === 'approval_response' ? 'comment-approval' : ''} ${isPending ? 'comment-pending-delete' : ''}`}>
              <div className="comment-head">
                <span className="author">{c.authorType}</span>
                {c.authorType === 'user' && (
                  isPending ? (
                    <span className="comment-delete-confirm-group" role="group" aria-label="Confirm delete">
                      <button
                        type="button"
                        className="comment-delete-confirm"
                        onClick={() => onDelete(c.id)}
                        disabled={deletingId === c.id}
                      >
                        Delete?
                      </button>
                      <button
                        type="button"
                        className="comment-delete-cancel"
                        onClick={cancelPendingDelete}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="comment-delete"
                      onClick={() => onDelete(c.id)}
                      disabled={deletingId === c.id}
                      aria-label="Delete comment"
                      title="Delete comment"
                    >
                      {deletingId === c.id ? '…' : '×'}
                    </button>
                  )
                )}
              </div>
              <p>{c.body}</p>
            </li>
          );
        })}
      </ul>
      <form onSubmit={onSubmit} className="comment-form">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a reply…"
          rows={3}
        />
        <button type="submit" disabled={!canSend}>
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}