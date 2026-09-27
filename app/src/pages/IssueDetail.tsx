import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useApi } from '../api/context';
import type { Issue, Comment } from '../api/types';

export function IssueDetail() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    Promise.all([api.getIssue(id), api.listComments(id)])
      .then(([iss, cmts]) => {
        if (cancelled) return;
        setIssue(iss);
        setComments(cmts);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [api, id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!id || !draft.trim() || submitting) return;
    setSubmitting(true);
    try {
      const c = await api.addComment(id, { body: draft.trim() });
      setComments((prev) => [...(prev ?? []), c]);
      setDraft('');
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!id) return <div className="page issue-detail"><h2>Issue</h2><p>Missing id.</p></div>;
  if (error) return <div className="page issue-detail error">Error: {error}</div>;
  if (!issue || !comments) return <div className="page issue-detail loading">Loading…</div>;

  return (
    <div className="page issue-detail">
      <h2>{issue.title}</h2>
      <div className="meta">
        <span className={`badge badge-${issue.status}`}>{issue.status}</span>
        <span className={`badge badge-priority-${issue.priority}`}>{issue.priority}</span>
        <code className="workspace">{issue.workspacePath}</code>
      </div>
      <ul className="comments">
        {comments.map((c) => (
          <li key={c.id} className={`comment comment-${c.authorType}`}>
            <span className="author">{c.authorType}</span>
            <p>{c.body}</p>
          </li>
        ))}
      </ul>
      <form onSubmit={onSubmit} className="comment-form">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a reply…"
          rows={3}
        />
        <button type="submit" disabled={!draft.trim() || submitting}>
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  );
}