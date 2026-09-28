import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import type { Issue, BroadcastEvent } from '../api/types';
import { WsClient } from '../ws';
import { storage } from '../storage';

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'Running' },
  { value: 'done', label: 'Done' },
  { value: 'failed', label: 'Failed' },
] as const;
type StatusFilter = typeof STATUS_FILTERS[number]['value'];

type SortKey = 'updated' | 'created' | 'priority';

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function Inbox() {
  const api = useApi();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');

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

  // Filter + search + sort — pure derivation, no extra fetches. Memoized so
  // typing in the search box doesn't re-sort the underlying array.
  const visible = useMemo(() => {
    if (!issues) return null;
    const q = query.trim().toLowerCase();
    let rows = issues;
    if (filter !== 'all') rows = rows.filter((i) => i.status === filter);
    if (q) rows = rows.filter((i) => i.title.toLowerCase().includes(q));
    rows = [...rows];
    rows.sort((a, b) => {
      const aCreated = String(a.createdAt);
      const bCreated = String(b.createdAt);
      const aUpdated = String(a.updatedAt);
      const bUpdated = String(b.updatedAt);
      switch (sort) {
        case 'created':
          return bCreated.localeCompare(aCreated);
        case 'priority':
          return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9)
            || bUpdated.localeCompare(aUpdated);
        case 'updated':
        default:
          return bUpdated.localeCompare(aUpdated);
      }
    });
    return rows;
  }, [issues, filter, query, sort]);

  if (error) return <div className="page inbox error">Error: {error}</div>;
  if (issues === null) return <div className="page inbox loading">Loading…</div>;

  const empty = !visible || visible.length === 0;
  const totalCount = issues?.length ?? 0;

  return (
    <div className="page inbox">
      <div className="inbox-header">
        <h2>Inbox</h2>
        <span className="muted">{totalCount} issue{totalCount === 1 ? '' : 's'}</span>
      </div>

      <div className="inbox-toolbar">
        <div className="inbox-filters" role="tablist" aria-label="Filter by status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="tab"
              aria-selected={filter === f.value}
              className={`filter-pill ${filter === f.value ? 'active' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="inbox-toolbar-right">
          <input
            className="inbox-search"
            type="search"
            inputMode="search"
            placeholder="Search title…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <select
            className="inbox-sort"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort"
          >
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="priority">Priority</option>
          </select>
        </div>
      </div>

      {empty ? (
        <div className="inbox-empty">
          {totalCount === 0 ? (
            <>
              <p>No issues yet.</p>
              <p className="muted">Create one to start a Claude session.</p>
            </>
          ) : (
            <>
              <p>No issues match your filter.</p>
              <p className="muted">Try a different status or clear the search.</p>
            </>
          )}
        </div>
      ) : (
        <ul className="issue-list">
          {visible!.map((i) => (
            <li key={i.id} className={`issue-item status-${i.status}`}>
              <Link to={`/issues/${i.id}`}>
                <span className="title">{i.title}</span>
                <span className="issue-meta">
                  <span className={`badge badge-${i.status}`}>{i.status.replace('_', ' ')}</span>
                  <span className={`badge badge-priority-${i.priority}`}>{i.priority}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}