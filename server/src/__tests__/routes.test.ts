import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { eq } from 'drizzle-orm';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { issues, comments, runs } from '../db/schema.js';
import { issuesRouter } from '../routes/issues.js';

const TOKEN = 'sk-test';

async function setupApp() {
  const dbPath = path.join(os.tmpdir(), `routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = createDb(dbPath);
  await migrate(db);
  const app = express();
  app.use(express.json());
  app.use('/api/issues', issuesRouter(db, TOKEN));
  return { app, db, dbPath };
}

describe('issues routes', () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let dbPath: string;

  beforeEach(async () => {
    ctx = await setupApp();
    dbPath = ctx.dbPath;
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('POST /api/issues creates an issue', async () => {
    const res = await request(ctx.app)
      .post('/api/issues')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ title: 'fix bug', workspacePath: '/tmp/x' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTypeOf('string');
    expect(res.body.title).toBe('fix bug');
  });

  it('GET /api/issues lists issues', async () => {
    await request(ctx.app).post('/api/issues').set('Authorization', `Bearer ${TOKEN}`).send({ title: 'a', workspacePath: '/x' });
    await request(ctx.app).post('/api/issues').set('Authorization', `Bearer ${TOKEN}`).send({ title: 'b', workspacePath: '/x' });
    const res = await request(ctx.app).get('/api/issues').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.body).toHaveLength(2);
  });

  it('GET /api/issues/:id returns single issue', async () => {
    const create = await request(ctx.app).post('/api/issues').set('Authorization', `Bearer ${TOKEN}`).send({ title: 'a', workspacePath: '/x' });
    const res = await request(ctx.app).get(`/api/issues/${create.body.id}`).set('Authorization', `Bearer ${TOKEN}`);
    expect(res.body.title).toBe('a');
  });

  it('POST /api/issues rejects without auth', async () => {
    const res = await request(ctx.app).post('/api/issues').send({ title: 'a', workspacePath: '/x' });
    expect(res.status).toBe(401);
  });

  it('POST /api/issues/:id/comments creates user comment', async () => {
    const issue = await request(ctx.app).post('/api/issues').set('Authorization', `Bearer ${TOKEN}`).send({ title: 'i', workspacePath: '/x' });
    const res = await request(ctx.app)
      .post(`/api/issues/${issue.body.id}/comments`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ body: 'continue' });
    expect(res.status).toBe(201);
    expect(res.body.authorType).toBe('user');
    expect(res.body.kind).toBe('message');
  });

  it('GET /api/issues/:id/comments lists comments in order', async () => {
    const issue = await request(ctx.app).post('/api/issues').set('Authorization', `Bearer ${TOKEN}`).send({ title: 'i', workspacePath: '/x' });
    const id = issue.body.id;
    await request(ctx.app).post(`/api/issues/${id}/comments`).set('Authorization', `Bearer ${TOKEN}`).send({ body: 'first' });
    await request(ctx.app).post(`/api/issues/${id}/comments`).set('Authorization', `Bearer ${TOKEN}`).send({ body: 'second' });
    const res = await request(ctx.app).get(`/api/issues/${id}/comments`).set('Authorization', `Bearer ${TOKEN}`);
    expect(res.body.map((c: any) => c.body)).toEqual(['first', 'second']);
  });

  it('GET /api/issues/:id returns 404 for unknown id', async () => {
    const res = await request(ctx.app).get('/api/issues/does-not-exist').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('POST /api/issues/:id/comments returns 404 for unknown issue', async () => {
    const res = await request(ctx.app)
      .post('/api/issues/does-not-exist/comments')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ body: 'hi' });
    expect(res.status).toBe(404);
  });

  it('POST /api/issues/:id/comments returns 400 for missing body', async () => {
    const issue = await request(ctx.app).post('/api/issues').set('Authorization', `Bearer ${TOKEN}`).send({ title: 'i', workspacePath: '/x' });
    const res = await request(ctx.app)
      .post(`/api/issues/${issue.body.id}/comments`)
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /api/issues persists priority', async () => {
    const create = await request(ctx.app)
      .post('/api/issues')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ title: 'urgent', workspacePath: '/x', priority: 'high' });
    expect(create.body.priority).toBe('high');
    const get = await request(ctx.app).get(`/api/issues/${create.body.id}`).set('Authorization', `Bearer ${TOKEN}`);
    expect(get.body.priority).toBe('high');
  });

  it('POST /api/issues/:id/comments fires a broadcast', async () => {
    const broadcasted: any[] = [];
    const bc = (m: any) => broadcasted.push(m);

    const dbPath = path.join(os.tmpdir(), `bc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDb(dbPath);
    await migrate(db);
    const app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter(db, TOKEN, bc));

    try {
      const create = await request(app)
        .post('/api/issues')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ title: 'i', workspacePath: '/x' });
      await request(app)
        .post(`/api/issues/${create.body.id}/comments`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ body: 'go' });

      expect(broadcasted.some((b) => b.kind === 'run.queued')).toBe(true);
    } finally {
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    }
  });

  it('POST /api/issues/:id/comments does NOT broadcast on unknown issue', async () => {
    const broadcasted: any[] = [];
    const bc = (m: any) => broadcasted.push(m);

    const dbPath = path.join(os.tmpdir(), `bc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDb(dbPath);
    await migrate(db);
    const app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter(db, TOKEN, bc));

    try {
      const res = await request(app)
        .post('/api/issues/does-not-exist/comments')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ body: 'hi' });
      expect(res.status).toBe(404);
      expect(broadcasted).toHaveLength(0);
    } finally {
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    }
  });

  it('POST /api/issues/:id/comments does NOT broadcast on cancelled issue', async () => {
    const broadcasted: any[] = [];
    const bc = (m: any) => broadcasted.push(m);

    const dbPath = path.join(os.tmpdir(), `bc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDb(dbPath);
    await migrate(db);
    const app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter(db, TOKEN, bc));

    try {
      // Create an issue via the route.
      const create = await request(app)
        .post('/api/issues')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ title: 'i', workspacePath: '/x' });
      const issueId = create.body.id;

      // Force the issue into 'cancelled' via direct DB update.
      await db.update(issues)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(issues.id, issueId))
        .run();

      const res = await request(app)
        .post(`/api/issues/${issueId}/comments`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ body: 'hi' });
      expect(res.status).toBe(409);
      expect(broadcasted).toHaveLength(0);
    } finally {
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    }
  });

  it('POST /api/issues/:id/comments does NOT broadcast on done (terminal) issue', async () => {
    const broadcasted: any[] = [];
    const bc = (m: any) => broadcasted.push(m);

    const dbPath = path.join(os.tmpdir(), `bc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDb(dbPath);
    await migrate(db);
    const app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter(db, TOKEN, bc));

    try {
      // Create an issue via the route.
      const create = await request(app)
        .post('/api/issues')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ title: 'i', workspacePath: '/x' });
      const issueId = create.body.id;

      // Force the issue into 'done' (terminal) via direct DB update.
      await db.update(issues)
        .set({ status: 'done', updatedAt: new Date() })
        .where(eq(issues.id, issueId))
        .run();

      const res = await request(app)
        .post(`/api/issues/${issueId}/comments`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ body: 'hi' });
      expect(res.status).toBe(409);
      expect(broadcasted).toHaveLength(0);
    } finally {
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    }
  });

  it('POST /api/issues/:id/comments still returns 201 if broadcast throws', async () => {
    const dbPath = path.join(os.tmpdir(), `bc-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDb(dbPath);
    await migrate(db);
    const app = express();
    app.use(express.json());
    // Throwing broadcaster — must NOT break the HTTP response.
    app.use('/api/issues', issuesRouter(db, TOKEN, () => { throw new Error('boom'); }));

    try {
      const create = await request(app)
        .post('/api/issues')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ title: 'i', workspacePath: '/x' });
      const res = await request(app)
        .post(`/api/issues/${create.body.id}/comments`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ body: 'go' });
      expect(res.status).toBe(201);
    } finally {
      try { fs.unlinkSync(dbPath); } catch {}
      try { fs.unlinkSync(dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(dbPath + '-shm'); } catch {}
    }
  });

  async function setupAppWithBroadcast(): Promise<{
    app: express.Express;
    db: ReturnType<typeof createDb>;
    dbPath: string;
    broadcasted: any[];
  }> {
    const broadcasted: any[] = [];
    const bc = (m: any) => broadcasted.push(m);
    const dbPath = path.join(os.tmpdir(), `approval-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDb(dbPath);
    await migrate(db);
    const app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter(db, TOKEN, bc));
    return { app, db, dbPath, broadcasted };
  }

  it("POST /api/issues/:id/comments with body 'yes' persists as approval_response and broadcasts approval.responded", async () => {
    const ctx = await setupAppWithBroadcast();
    try {
      const create = await request(ctx.app)
        .post('/api/issues')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ title: 'i', workspacePath: '/x' });
      const issueId = create.body.id;

      const res = await request(ctx.app)
        .post(`/api/issues/${issueId}/comments`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ body: 'yes' });

      expect(res.status).toBe(201);
      expect(res.body.body).toBe('yes');
      expect(res.body.kind).toBe('approval_response');

      const cs = await ctx.db.select().from(comments).where(eq(comments.issueId, issueId)).all();
      expect(cs).toHaveLength(1);
      expect(cs[0]!.kind).toBe('approval_response');
      expect(cs[0]!.body).toBe('yes');

      const appr = ctx.broadcasted.find((b) => b.kind === 'approval.responded');
      expect(appr).toBeDefined();
      expect(appr.value).toBe('yes');
      expect(appr.issueId).toBe(issueId);
    } finally {
      try { fs.unlinkSync(ctx.dbPath); } catch {}
      try { fs.unlinkSync(ctx.dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(ctx.dbPath + '-shm'); } catch {}
    }
  });

  it("POST /api/issues/:id/comments with body 'no' persists as approval_response and broadcasts approval.responded", async () => {
    const ctx = await setupAppWithBroadcast();
    try {
      const create = await request(ctx.app)
        .post('/api/issues')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ title: 'i', workspacePath: '/x' });
      const issueId = create.body.id;

      const res = await request(ctx.app)
        .post(`/api/issues/${issueId}/comments`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ body: 'no' });

      expect(res.status).toBe(201);
      expect(res.body.body).toBe('no');
      expect(res.body.kind).toBe('approval_response');

      const cs = await ctx.db.select().from(comments).where(eq(comments.issueId, issueId)).all();
      expect(cs).toHaveLength(1);
      expect(cs[0]!.kind).toBe('approval_response');
      expect(cs[0]!.body).toBe('no');

      const appr = ctx.broadcasted.find((b) => b.kind === 'approval.responded');
      expect(appr).toBeDefined();
      expect(appr.value).toBe('no');
      expect(appr.issueId).toBe(issueId);
    } finally {
      try { fs.unlinkSync(ctx.dbPath); } catch {}
      try { fs.unlinkSync(ctx.dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(ctx.dbPath + '-shm'); } catch {}
    }
  });

  it("POST /api/issues/:id/comments with body 'yes' does NOT create a new run", async () => {
    const ctx = await setupAppWithBroadcast();
    try {
      const create = await request(ctx.app)
        .post('/api/issues')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ title: 'i', workspacePath: '/x' });
      const issueId = create.body.id;

      const res = await request(ctx.app)
        .post(`/api/issues/${issueId}/comments`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .send({ body: 'yes' });
      expect(res.status).toBe(201);

      const rs = await ctx.db.select().from(runs).where(eq(runs.issueId, issueId)).all();
      expect(rs).toHaveLength(0);

      // And no run.queued broadcast.
      expect(ctx.broadcasted.some((b) => b.kind === 'run.queued')).toBe(false);
    } finally {
      try { fs.unlinkSync(ctx.dbPath); } catch {}
      try { fs.unlinkSync(ctx.dbPath + '-wal'); } catch {}
      try { fs.unlinkSync(ctx.dbPath + '-shm'); } catch {}
    }
  });
});