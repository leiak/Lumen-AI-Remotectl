import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import { storage } from '../storage';
import type { IssuePriority } from '../api/types';

const PRIORITIES = ['low', 'medium', 'high'] as const satisfies readonly IssuePriority[];

export function NewIssue() {
  const api = useApi();
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [workspacePath, setWorkspace] = useState(() => storage.getWorkspaceDefault() ?? '');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [startImmediately, setStartImmediately] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = title.trim().length > 0 && workspacePath.trim().length > 0 && !submitting;

  async function onCreate() {
    if (!canCreate) return;
    setSubmitting(true);
    setError(null);
    try {
      const issue = await api.createIssue({
        title: title.trim(),
        workspacePath: workspacePath.trim(),
        priority,
      });
      // Remember the chosen workspace so the next New Issue page is pre-filled.
      storage.setWorkspaceDefault(workspacePath.trim());
      // A first comment kicks off the issue's heartbeat.
      if (startImmediately) {
        await api.addComment(issue.id, { body: title.trim() });
      }
      nav(`/issues/${issue.id}`);
    } catch (e) {
      setError(fmtError(e));
      setSubmitting(false);
    }
  }

  return (
    <div className="page new-issue">
      <h2>New Issue</h2>
      {error && <p className="form-error">Error: {error}</p>}
      <label className="field">
        <span className="field-label">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs doing?"
        />
      </label>
      <label className="field">
        <span className="field-label">Workspace</span>
        <input
          value={workspacePath}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder="/path/to/workspace"
        />
      </label>
      <div className="field">
        <span className="field-label">Priority</span>
        <div className="priority-group" role="radiogroup" aria-label="Priority">
          {PRIORITIES.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={priority === p}
              className={`priority-btn ${priority === p ? 'active' : ''}`}
              onClick={() => setPriority(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <label className="field checkbox-field">
        <input
          type="checkbox"
          checked={startImmediately}
          onChange={(e) => setStartImmediately(e.target.checked)}
        />
        <span>Start immediately (post first comment to trigger heartbeat)</span>
      </label>
      <button
        type="button"
        onClick={onCreate}
        disabled={!canCreate}
        className="primary"
      >
        {submitting ? 'Creating…' : 'Create'}
      </button>
    </div>
  );
}
