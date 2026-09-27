import { Router } from 'express';
import { eq, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues, comments, runs } from '../db/schema.js';
import { createAuthMiddleware } from '../auth.js';

const ALLOWED_PRIORITIES = ['low', 'medium', 'high'] as const;
type Priority = typeof ALLOWED_PRIORITIES[number];

export function issuesRouter(db: Db, apiKey: string): Router {
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
          authorType: 'user', body, kind: 'message',
          createdAt: now,
        }).run();

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

        return { kind: 'ok' as const, commentId: id };
      });

      if (result.kind === 'not_found') return res.status(404).json({ error: 'issue_not_found' });
      if (result.kind === 'cancelled') return res.status(409).json({ error: 'issue_cancelled' });
      if (result.kind === 'invalid_status') return res.status(409).json({ error: 'issue_terminal', status: 'cancelled_or_done' });
      return res.status(201).json({ id: result.commentId, issueId: req.params.id, authorType: 'user', body, kind: 'message' });
    } catch (e) {
      return res.status(500).json({ error: 'internal' });
    }
  });

  r.get('/:id/comments', async (req, res) => {
    const rows = await db.select().from(comments).where(eq(comments.issueId, req.params.id)).orderBy(comments.createdAt).all();
    res.json(rows);
  });

  return r;
}
