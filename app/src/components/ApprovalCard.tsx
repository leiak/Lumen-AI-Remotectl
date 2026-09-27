import { useState } from 'react';
import { useApi } from '../api/context';
import { APPROVAL_NO, APPROVAL_YES, type ApprovalValue } from '../api/constants';

export interface ApprovalCardProps {
  issueId: string;
  commentId: string;
  body: string;
  onResolved: () => void;
}

export function ApprovalCard({ issueId, commentId, body, onResolved }: ApprovalCardProps) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = async (value: ApprovalValue) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.addComment(issueId, { body: value });
      onResolved();
    } catch (e) {
      console.error('approval response failed:', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="comment comment-approval-request approval-card" data-comment-id={commentId}>
      <span className="author">assistant</span>
      <p>{body}</p>
      {error && <p className="approval-error">Failed to send response: {error}</p>}
      <div className="approval-actions">
        <button type="button" onClick={() => respond(APPROVAL_YES)} disabled={busy} aria-label="Approve">
          {busy ? '…' : '✓ Approve'}
        </button>
        <button type="button" onClick={() => respond(APPROVAL_NO)} disabled={busy} aria-label="Deny">
          {busy ? '…' : '✗ Deny'}
        </button>
      </div>
    </li>
  );
}