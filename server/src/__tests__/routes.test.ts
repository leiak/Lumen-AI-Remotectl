import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
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
});