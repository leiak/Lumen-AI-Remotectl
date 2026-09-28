import { Router } from 'express';
import { eq, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues, comments, runs } from '../db/schema.js';
import { createAuthMiddleware } from '../auth.js';
import type { RouteEvent } from '../events/translate.js';
import type { PendingApprovals } from '../scheduler/pending.js';

const ALLOWED_PRIORITIES = ['low', 'medium', 'high'] as const;
type Priority = typeof ALLOWED_PRIORITIES[number];

export function issuesRouter(
  db: Db,
  apiKey: string,
  broadcast?: (msg: RouteEvent) => void,
  pendingApprovals?: PendingApprovals,
): Router {
  const r = Router();
  r.use(createAuthMiddleware(apiKey));

  r.post('/', async (req, res) => {
    const { title, workspacePath, priority } = req.body as { title?: unknown; workspacePath?: unknown; priority?: unknown };
    if (typeof title !== 'string' || !title) return res.status(400).json({ error: 'title_required_string' });
    if (typeof workspacePath !== 'string' || !workspacePath) return res.status(400).json({ error: 'workspacePath_required_string' });
    const prio: Priority = (typeof priority === 'string' && (ALLOWED_PRIORITIES as readonly string[]).includes(priority))
      ? (priority as Priority)
      : 'medium';
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(issues).values({
      id, title,
      status: 'todo',
      priority: prio,
      workspacePath,
      createdAt: now, updatedAt: now,
    }).run();
    res.status(201).json({ id, title, status: 'todo', workspacePath, priority: prio });
  });

  r.get('/', async (_req, res) => {
    const rows = await db.select().from(issues).orderBy(desc(issues.updatedAt)).all();
    res.json(rows);
  });

  r.get('/:id', async (req, res) => {
    const row = await db.select().from(issues).where(eq(issues.id, req.params.id)).get();
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(row);
  });

  r.post('/:id/comments', async (req, res) => {
    const { body } = req.body as { body?: unknown };
    if (typeof body !== 'string' || !body) return res.status(400).json({ error: 'body_required_string' });

    // Approval reply tokens — must match app/src/api/constants.ts APPROVAL_YES/APPROVAL_NO
    const isApprovalReply = body === 'yes' || body === 'no';
    const kind: 'message' | 'approval_response' = isApprovalReply ? 'approval_response' : 'message';
    const approvalValue = body === 'yes' ? ('yes' as const) : ('no' as const);

    try {
      const result = await db.transaction(async (tx) => {
        const issue = await tx.select().from(issues).where(eq(issues.id, req.params.id)).get();
        if (!issue) return { kind: 'not_found' as const };
        if (issue.status === 'cancelled') return { kind: 'cancelled' as const };
        if (!['todo', 'in_progress', 'in_review'].includes(issue.status)) {
          return { kind: 'invalid_status' as const };
        }

        const id = crypto.randomUUID();
        const now = new Date();
        await tx.insert(comments).values({
          id, issueId: req.params.id,
          authorType: 'user', body, kind,
          createdAt: now,
        }).run();

        // Approval replies resume the existing claude run; they do NOT spawn a new run.
        if (isApprovalReply) {
          return { kind: 'ok' as const, commentId: id, runId: null };
        }

        const runId = crypto.randomUUID();
        await tx.insert(runs).values({
          id: runId, issueId: req.params.id, status: 'queued', trigger: 'on_comment',
          createdAt: now,
        }).run();

        // Only flip to in_progress if currently todo or in_review
        if (issue.status === 'todo' || issue.status === 'in_review') {
          await tx.update(issues)
            .set({ status: 'in_progress', updatedAt: now })
            .where(eq(issues.id, req.params.id))
            .run();
        }

        return { kind: 'ok' as const, commentId: id, runId };
      });

      if (result.kind === 'not_found') return res.status(404).json({ error: 'issue_not_found' });
      if (result.kind === 'cancelled') return res.status(409).json({ error: 'issue_cancelled' });
      if (result.kind === 'invalid_status') return res.status(409).json({ error: 'issue_terminal', status: 'cancelled_or_done' });

      // Broadcast (best-effort). A failure here must not break the response — the
      // comment + (optional) run are already committed by the transaction.
      try {
        if (isApprovalReply) {
          // Forward the response to the awaiting runner. If no approval is
          // currently pending (e.g. the user tapped twice, or Claude has
          // already exited) respond() returns false and we silently no-op —
          // the comment is still recorded for the audit trail.
          pendingApprovals?.respond(req.params.id, approvalValue);
          broadcast?.({ kind: 'approval.responded', issueId: req.params.id, value: body });
        } else if (result.runId) {
          broadcast?.({ kind: 'run.queued', issueId: req.params.id, runId: result.runId });
        }
      } catch (e) {
        console.error('broadcast failed:', e);
      }

      return res.status(201).json({ id: result.commentId, issueId: req.params.id, authorType: 'user', body, kind });
    } catch (e) {
      return res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/:id/comments', async (req, res) => {
    const rows = await db.select().from(comments).where(eq(comments.issueId, req.params.id)).orderBy(comments.createdAt).all();
    res.json(rows);
  });

  // Delete a comment. Used by the mobile UI to remove a user message — the
  // user-facing case is "I just sent a comment I want to take back". Only
  // user-authored comments can be deleted; agent / approval_request rows
  // belong to the run and are immutable.
  r.delete('/:id/comments/:commentId', async (req, res) => {
    const { id: issueId, commentId } = req.params;
    try {
      const existing = await db
        .select()
        .from(comments)
        .where(eq(comments.id, commentId))
        .get();
      if (!existing) return res.status(404).json({ error: 'comment_not_found' });
      if (existing.issueId !== issueId) {
        // Defensive: comment IDs are UUIDs so collisions are vanishingly
        // unlikely, but if they ever happen we want a 404, not a wrong-row
        // delete.
        return res.status(404).json({ error: 'comment_not_found' });
      }
      if (existing.authorType !== 'user') {
        return res.status(403).json({ error: 'comment_not_user_authored' });
      }
      await db.delete(comments).where(eq(comments.id, commentId)).run();
      // Broadcast so other connected clients refresh their view.
      broadcast?.({ kind: 'comment.deleted', issueId, commentId });
      return res.status(204).end();
    } catch (e) {
      console.error('DELETE /api/issues/:id/comments/:commentId failed:', e);
      return res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
