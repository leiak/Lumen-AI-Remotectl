import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import type { Issue } from '../api/types';

export function Inbox() {
  const api = useApi();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.listIssues()
      .then((data) => { if (!cancelled) { setError(null); setIssues(data); } })
      .catch((e) => { if (!cancelled) setError(fmtError(e)); });
    return () => { cancelled = true; };
  }, [api]);

  if (error) return <div className="page inbox error">Error: {error}</div>;
  if (issues === null) return <div className="page inbox loading">Loading…</div>;
  if (issues.length === 0) return <div className="page inbox empty"><h2>Inbox</h2><p>No issues yet.</p></div>;

  return (
    <div className="page inbox">
      <h2>Inbox</h2>
      <ul className="issue-list">
        {issues.map((i) => (
          <li key={i.id} className={`issue-item status-${i.status}`}>
            <Link to={`/issues/${i.id}`}>
              <span className="title">{i.title}</span>
              <span className={`badge badge-${i.status}`}>{i.status}</span>
              <span className={`badge badge-priority-${i.priority}`}>{i.priority}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}