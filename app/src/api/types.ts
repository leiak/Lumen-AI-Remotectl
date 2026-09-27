export type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'cancelled';
export type IssuePriority = 'low' | 'medium' | 'high';

export interface Issue {
  id: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  workspacePath: string;
  createdAt: number | string;
  updatedAt: number | string;
}

export interface Comment {
  id: string;
  issueId: string;
  authorType: 'user' | 'assistant';
  body: string;
  kind: 'message' | 'approval' | 'approval_response';
  createdAt: number | string;
}

export type BroadcastEvent =
  | { type: 'issue_updated'; issueId: string; status: IssueStatus }
  | { type: 'run_started'; runId: string; issueId: string }
  | { type: 'run_event'; runId: string; issueId: string; stream: 'stdout' | 'stderr'; content: string }
  | { type: 'run_finished'; runId: string; status: 'done' | 'failed' | 'cancelled'; error?: string }
  | { type: 'approval_required'; runId: string; issueId: string; question: string };
