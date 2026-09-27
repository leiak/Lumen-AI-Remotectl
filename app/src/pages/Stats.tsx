import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import type { Issue, IssueStatus as IssueStatusT } from '../api/types';

type StatusCounts = Record<IssueStatusT, number>;

const STATUSES: readonly IssueStatusT[] = ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] as const;

function emptyCounts(): StatusCounts {
  return { todo: 0, in_progress: 0, in_review: 0, done: 0, cancelled: 0 };
}

const STATUS_LABELS: Record<IssueStatusT, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function Stats() {
  const api = useApi();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track the most recent load and whether the component is still mounted so
  // that out-of-order responses from rapid Refresh clicks don't overwrite
  // newer data with stale data.
  const epochRef = useRef(0);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    const myEpoch = ++epochRef.current;
    setError(null);
    try {
      const data = await api.listIssues();
      if (cancelledRef.current || myEpoch !== epochRef.current) return;
      setIssues(data);
    } catch (e) {
      if (cancelledRef.current || myEpoch !== epochRef.current) return;
      setIssues(null);
      setError(fmtError(e));
    }
  }, [api]);

  useEffect(() => {
    cancelledRef.current = false;
    load();
    return () => { cancelledRef.current = true; };
  }, [load]);

  const counts: StatusCounts = (() => {
    if (!issues) return emptyCounts();
    return issues.reduce<StatusCounts>((acc, i) => {
      // Defensive: skip unknown statuses that might appear in a future server build.
      if (STATUSES.includes(i.status)) {
        acc[i.status] = (acc[i.status] ?? 0) + 1;
      }
      return acc;
    }, emptyCounts());
  })();

  const total = issues ? issues.length : 0;

  return (
    <div className="page stats">
      <h2>Stats</h2>

      {error && (
        <div className="stats error">
          <p className="form-error">Error: {error}</p>
        </div>
      )}

      {issues === null && !error && (
        <div className="stats loading">
          <p className="muted">Loading…</p>
        </div>
      )}

      {issues !== null && issues.length === 0 && !error && (
        <div className="stats empty">
          <p className="muted">No issues yet.</p>
        </div>
      )}

      {issues !== null && issues.length > 0 && (
        <>
          <div className="stats-card">
            <div className="stats-total">
              <span className="muted">Total</span>
              <span className="stats-total-value">{total}</span>
            </div>
            <div className="stats-grid">
              {STATUSES.map((s) => (
                <div key={s} className={`stats-tile status-${s}`}>
                  <div className="stats-tile-label">{STATUS_LABELS[s]}</div>
                  <div className="stats-tile-value">{counts[s]}</div>
                </div>
              ))}
            </div>
          </div>
          <button type="button" onClick={load} className="secondary stats-refresh">
            Refresh
          </button>
        </>
      )}
    </div>
  );
}