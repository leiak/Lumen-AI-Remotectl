import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import type { Issue, Comment, BroadcastEvent } from '../api/types';
import { ApprovalCard } from '../components/ApprovalCard';
import { WsClient } from '../ws';
import { storage } from '../storage';

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      setComments((prev) => [...prev, c]);
      setDraft('');
    } catch (e) {
      setError(fmtError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canSend = !!id && !!draft.trim() && !submitting;

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
          return (
            <li key={c.id} className={`comment comment-${c.authorType}`}>
              <span className="author">{c.authorType}</span>
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