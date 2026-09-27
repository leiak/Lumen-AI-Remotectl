import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import type { Issue, BroadcastEvent } from '../api/types';
import { WsClient } from '../ws';
import { storage } from '../storage';

export function Inbox() {
  const api = useApi();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refetch without resetting UI state — used by WS-driven reloads so the
  // list doesn't flicker to a loading skeleton on every server tick.
  const reload = useCallback(() => {
    setError(null);
    api.listIssues()
      .then((data) => setIssues(data))
      .catch((e) => setError(fmtError(e)));
  }, [api]);

  // Initial load — keeps the cancellation flag so an unmount mid-fetch
  // doesn't try to write state to a dead component.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.listIssues()
      .then((data) => { if (!cancelled) { setError(null); setIssues(data); } })
      .catch((e) => { if (!cancelled) setError(fmtError(e)); });
    return () => { cancelled = true; };
  }, [api]);

  // Live updates via WebSocket. Any issue-level event means our list may be
  // stale (status badges, ordering, new approvals). We deliberately don't
  // subscribe to `run_event` here — those are stream-level and too noisy
  // to refetch the whole inbox for.
  useEffect(() => {
    if (!storage.getHost() || !storage.getApiKey()) return;

    let cancelled = false;
    const ws = new WsClient({ baseBackoffMs: 1000, maxBackoffMs: 30_000 });
    const unsub = ws.onMessage((msg: BroadcastEvent) => {
      if (cancelled) return;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'issue_updated':
        case 'run_started':
        case 'run_finished':
        case 'approval_requested':
          reload();
          break;
      }
    });
    ws.connect();

    return () => {
      cancelled = true;
      unsub();
      ws.disconnect();
    };
  }, [reload]);

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