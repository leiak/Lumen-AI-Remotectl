import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import webpush from 'web-push';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { pushDevices } from '../db/schema.js';
import { pushRouter } from '../routes/push.js';
import {
  notify,
  _resetPushForTests,
  initPush,
  getVapidPublicKey,
} from '../push/notify.js';

const TOKEN = 'sk-test';

async function setupApp() {
  const dbPath = path.join(
    os.tmpdir(),
    `push-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = createDb(dbPath);
  await migrate(db);
  const app = express();
  app.use(express.json());
  app.use('/api/push', pushRouter(db, TOKEN));
  return { app, db, dbPath };
}

describe('VAPID / web-push', () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let dbPath: string;

  beforeEach(async () => {
    ctx = await setupApp();
    dbPath = ctx.dbPath;
    _resetPushForTests();
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('initPush() generates a VAPID keypair and persists it', async () => {
    await initPush(ctx.db);
    const key = getVapidPublicKey();
    expect(key).toBeTruthy();
    expect(key!.length).toBeGreaterThan(50);
  });

  it('initPush() reuses persisted keys across calls (stable public key)', async () => {
    await initPush(ctx.db);
    const k1 = getVapidPublicKey();
    _resetPushForTests();
    await initPush(ctx.db);
    const k2 = getVapidPublicKey();
    expect(k2).toBe(k1);
  });

  it('GET /api/push/vapid-public-key returns the public key after init', async () => {
    await initPush(ctx.db);
    const res = await request(ctx.app)
      .get('/api/push/vapid-public-key')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toBe(getVapidPublicKey());
  });

  it('GET /api/push/vapid-public-key returns 503 before init', async () => {
    const res = await request(ctx.app)
      .get('/api/push/vapid-public-key')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
  });

  it('GET /api/push/vapid-public-key returns 401 without auth', async () => {
    await initPush(ctx.db);
    const res = await request(ctx.app).get('/api/push/vapid-public-key');
    expect(res.status).toBe(401);
  });

  it('POST /api/push/subscribe stores a web subscription', async () => {
    const endpoint = 'https://push.example.com/abc/def';
    const res = await request(ctx.app)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({
        endpoint,
        keys: {
          p256dh: 'BPKjBpqj0fake-p256dh',
          auth: 'fake-auth-token',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe('web');
    expect(rows[0]!.deviceToken).toBe(endpoint);
    expect(rows[0]!.p256dh).toBe('BPKjBpqj0fake-p256dh');
    expect(rows[0]!.auth).toBe('fake-auth-token');
  });

  it('POST /api/push/subscribe upserts on duplicate endpoint', async () => {
    const endpoint = 'https://push.example.com/dup';
    const first = { p256dh: 'p1', auth: 'a1' };
    const second = { p256dh: 'p2', auth: 'a2' };

    await request(ctx.app)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ endpoint, keys: first });
    await request(ctx.app)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ endpoint, keys: second });

    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.p256dh).toBe('p2');
    expect(rows[0]!.auth).toBe('a2');
  });

  it('POST /api/push/subscribe returns 400 when keys are missing', async () => {
    const res = await request(ctx.app)
      .post('/api/push/subscribe')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ endpoint: 'https://push.example.com/x', keys: { p256dh: 'p' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_subscription');
  });

  it('POST /api/push/subscribe returns 401 without auth', async () => {
    const res = await request(ctx.app)
      .post('/api/push/subscribe')
      .send({ endpoint: 'x', keys: { p256dh: 'p', auth: 'a' } });
    expect(res.status).toBe(401);
  });
});

describe('push notify()', () => {
  let ctx: Awaited<ReturnType<typeof setupApp>>;
  let dbPath: string;

  beforeEach(async () => {
    ctx = await setupApp();
    dbPath = ctx.dbPath;
    _resetPushForTests();
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('notify() is a no-op when VAPID is not initialized', async () => {
    // Should not throw, even with no devices.
    await expect(notify(ctx.db, 'task_done', { message: 'hello' })).resolves.toBeUndefined();
  });

  it('notify() does not throw when VAPID is uninitialized but devices exist', async () => {
    await ctx.db.insert(pushDevices).values({
      id: 'dev-1',
      deviceToken: 'tok-1',
      platform: 'android',
      lastSeenAt: new Date(),
    }).run();

    await expect(
      notify(ctx.db, 'approval_required', { message: 'please approve' }),
    ).resolves.toBeUndefined();
  });

  it('notify() calls webpush.sendNotification for web devices', async () => {
    await initPush(ctx.db);
    const sendSpy = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as any);

    await ctx.db.insert(pushDevices).values({
      id: 'dev-web-1',
      deviceToken: 'https://push.example.com/endpoint',
      platform: 'web',
      p256dh: 'fake-p256dh',
      auth: 'fake-auth',
      lastSeenAt: new Date(),
    }).run();

    await notify(ctx.db, 'task_done', {
      message: 'all done',
      issueId: 'iss-1',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [sub, payload, opts] = sendSpy.mock.calls[0]!;
    expect(sub).toMatchObject({
      endpoint: 'https://push.example.com/endpoint',
      keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' },
    });
    expect(JSON.parse(payload as string)).toMatchObject({
      title: 'Task done',
      body: 'all done',
      data: JSON.stringify({ kind: 'task_done', issueId: 'iss-1' }),
    });
    expect((opts as any).TTL).toBeGreaterThan(0);
    sendSpy.mockRestore();
  });

  it('notify() skips non-web devices', async () => {
    await initPush(ctx.db);
    const sendSpy = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({} as any);

    await ctx.db.insert(pushDevices).values({
      id: 'dev-ios',
      deviceToken: 'fake-ios-token',
      platform: 'ios',
      lastSeenAt: new Date(),
    }).run();

    await notify(ctx.db, 'task_done', { message: 'done' });
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('notify() removes a web device when the push service returns 410', async () => {
    await initPush(ctx.db);
    const err: any = new Error('gone');
    err.statusCode = 410;
    const sendSpy = vi.spyOn(webpush, 'sendNotification').mockRejectedValue(err);

    await ctx.db.insert(pushDevices).values({
      id: 'dev-stale',
      deviceToken: 'https://push.example.com/stale',
      platform: 'web',
      p256dh: 'p',
      auth: 'a',
      lastSeenAt: new Date(),
    }).run();

    await notify(ctx.db, 'task_done', { message: 'x' });
    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(0);
    sendSpy.mockRestore();
  });
});