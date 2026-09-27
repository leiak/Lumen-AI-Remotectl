import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import type { Issue, Comment } from '../api/types';
import { ApprovalCard } from '../components/ApprovalCard';

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