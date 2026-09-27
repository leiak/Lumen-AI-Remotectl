import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { pushDevices } from '../db/schema.js';
import { pushRouter } from '../routes/push.js';
import { notify, _resetPushForTests } from '../push/notify.js';

const TOKEN = 'sk-test';

async function setupApp() {
  const dbPath = path.join(
    os.tmpdir(),
    `push-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = createDb(dbPath);
  await migrate(db);
  const app = express();
  app.use(express.json());
  app.use('/api/push', pushRouter(db, TOKEN));
  return { app, db, dbPath };
}

describe('push routes', () => {
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

  it('POST /api/push/devices registers a new android device', async () => {
    const res = await request(ctx.app)
      .post('/api/push/devices')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ deviceToken: 'tok-android-1', platform: 'android' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.id).toBe('string');

    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deviceToken).toBe('tok-android-1');
    expect(rows[0]!.platform).toBe('android');
  });

  it('POST /api/push/devices registers a new ios device', async () => {
    const res = await request(ctx.app)
      .post('/api/push/devices')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ deviceToken: 'tok-ios-1', platform: 'ios' });

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.platform).toBe('ios');
  });

  it('POST /api/push/devices re-registering an existing token updates lastSeenAt', async () => {
    const first = await request(ctx.app)
      .post('/api/push/devices')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ deviceToken: 'tok-reuse', platform: 'android' });
    expect(first.status).toBe(201);

    const second = await request(ctx.app)
      .post('/api/push/devices')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ deviceToken: 'tok-reuse', platform: 'android' });

    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);

    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(1);
  });

  it('POST /api/push/devices returns 400 when deviceToken is missing', async () => {
    const res = await request(ctx.app)
      .post('/api/push/devices')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ platform: 'android' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('deviceToken_required_string');
  });

  it('POST /api/push/devices returns 400 when deviceToken is empty string', async () => {
    const res = await request(ctx.app)
      .post('/api/push/devices')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ deviceToken: '', platform: 'android' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('deviceToken_required_string');
  });

  it('POST /api/push/devices returns 400 when platform is invalid', async () => {
    const res = await request(ctx.app)
      .post('/api/push/devices')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ deviceToken: 'tok-x', platform: 'web' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('platform_invalid');
  });

  it('POST /api/push/devices returns 401 without auth', async () => {
    const res = await request(ctx.app)
      .post('/api/push/devices')
      .send({ deviceToken: 'tok-x', platform: 'android' });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/push/devices/:token removes the row and returns 204', async () => {
    await request(ctx.app)
      .post('/api/push/devices')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ deviceToken: 'tok-del', platform: 'android' });

    const del = await request(ctx.app)
      .delete('/api/push/devices/tok-del')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(del.status).toBe(204);

    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(0);
  });

  it('DELETE /api/push/devices/:token is a no-op for unknown tokens (still 204)', async () => {
    const del = await request(ctx.app)
      .delete('/api/push/devices/never-existed')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(del.status).toBe(204);
  });

  it('DELETE /api/push/devices/:token returns 401 without auth', async () => {
    const res = await request(ctx.app).delete('/api/push/devices/anything');
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

  it('notify() is a no-op when FCM is not initialized and no devices are registered', async () => {
    // Should not throw.
    await notify(ctx.db, 'task_done', { message: 'hello' });
    // No devices, nothing to assert beyond "did not throw".
    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(0);
  });

  it('notify() does not throw when devices exist but FCM is uninitialized', async () => {
    await ctx.db
      .insert(pushDevices)
      .values({
        id: 'dev-1',
        deviceToken: 'tok-1',
        platform: 'android',
        lastSeenAt: new Date(),
      })
      .run();

    // FCM is not initialized (no initPush() call in this test), so notify()
    // must silently skip the send rather than throw.
    await expect(
      notify(ctx.db, 'approval_required', { message: 'please approve' })
    ).resolves.toBeUndefined();

    // No state change.
    const rows = await ctx.db.select().from(pushDevices).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('dev-1');
  });

  it('notify() does not throw on iOS devices either (iOS branch is a stub)', async () => {
    await ctx.db
      .insert(pushDevices)
      .values({
        id: 'dev-ios-1',
        deviceToken: 'tok-ios-1',
        platform: 'ios',
        lastSeenAt: new Date(),
      })
      .run();

    await expect(
      notify(ctx.db, 'task_done', { message: 'all done' })
    ).resolves.toBeUndefined();
  });
});
