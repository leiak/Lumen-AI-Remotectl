import { Router } from 'express';
import { eq, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { issues, comments } from '../db/schema.js';
import { createAuthMiddleware } from '../auth.js';

export function issuesRouter(db: Db, apiKey: string = 'sk-test'): Router {
  const r = Router();
  r.use(createAuthMiddleware(apiKey));

  r.post('/', async (req, res) => {
    const { title, workspacePath, priority } = req.body as { title: string; workspacePath: string; priority?: string };
    if (!title || !workspacePath) return res.status(400).json({ error: 'title and workspacePath required' });
    const id = crypto.randomUUID();
    const now = new Date();
    await db.insert(issues).values({
      id, title,
      status: 'todo',
      priority: (priority as any) ?? 'medium',
      workspacePath,
      createdAt: now, updatedAt: now,
    }).run();
    res.status(201).json({ id, title, status: 'todo', workspacePath });
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
    const { body } = req.body as { body: string };
    if (!body) return res.status(400).json({ error: 'body required' });
    const issue = await db.select().from(issues).where(eq(issues.id, req.params.id)).get();
    if (!issue) return res.status(404).json({ error: 'issue_not_found' });
    const id = crypto.randomUUID();
    await db.insert(comments).values({
      id, issueId: req.params.id,
      authorType: 'user', body, kind: 'message',
      createdAt: new Date(),
    }).run();
    res.status(201).json({ id, issueId: req.params.id, authorType: 'user', body, kind: 'message' });
  });

  r.get('/:id/comments', async (req, res) => {
    const rows = await db.select().from(comments).where(eq(comments.issueId, req.params.id)).orderBy(comments.createdAt).all();
    res.json(rows);
  });

  return r;
}