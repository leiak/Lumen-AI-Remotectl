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
  const [kickoff, setKickoff] = useState('');
  const [kickoffTouched, setKickoffTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canCreate = title.trim().length > 0 && workspacePath.trim().length > 0 && !submitting;

  // Keep the kickoff prompt in sync with the title until the user edits it manually.
  const effectiveKickoff = kickoffTouched
    ? kickoff
    : (title.trim().length > 0 ? `Please begin work on: ${title.trim()}` : '');

  function onTitleChange(value: string) {
    setTitle(value);
    if (!kickoffTouched) {
      setKickoff(value.trim().length > 0 ? `Please begin work on: ${value.trim()}` : '');
    }
  }

  function onKickoffChange(value: string) {
    setKickoffTouched(true);
    setKickoff(value);
  }

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

      // Navigate immediately so the user can always find the issue they just created,
      // even if the kickoff comment fails to post.
      nav(`/issues/${issue.id}`);

      if (startImmediately) {
        const prompt = effectiveKickoff.trim().length > 0
          ? effectiveKickoff
          : `Please begin work on: ${title.trim()}`;
        // Fire-and-forget: don't block navigation. A failure here is logged but
        // doesn't strand the user — the issue exists and is reachable.
        api.addComment(issue.id, { body: prompt }).catch((e) => {
          console.error('addComment failed:', e);
        });
      }
    } catch (e) {
      setError(fmtError(e));
      setSubmitting(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    void onCreate();
  }

  return (
    <div className="page new-issue">
      <h2>New Issue</h2>
      {error && <p className="form-error">Error: {error}</p>}
      <form onSubmit={onSubmit} className="new-issue">
        <label className="field">
          <span className="field-label">Title</span>
          <input
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
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
          <span>Start immediately (post kickoff prompt to trigger heartbeat)</span>
        </label>
        {startImmediately && (
          <label className="field">
            <span className="field-label">Kickoff prompt</span>
            <textarea
              value={effectiveKickoff}
              onChange={(e) => onKickoffChange(e.target.value)}
              placeholder="What should the agent do first?"
              rows={3}
            />
          </label>
        )}
        <button
          type="submit"
          disabled={!canCreate}
          className="primary"
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
      </form>
    </div>
  );
}
