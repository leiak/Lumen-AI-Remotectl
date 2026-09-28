import { Router } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pushDevices } from '../db/schema.js';
import { createAuthMiddleware } from '../auth.js';
import { getVapidPublicKey } from '../push/notify.js';

const ALLOWED_PLATFORMS = ['ios', 'android', 'web'] as const;
type Platform = typeof ALLOWED_PLATFORMS[number];

export function pushRouter(db: Db, apiKey: string): Router {
  const r = Router();
  r.use(createAuthMiddleware(apiKey));

  // Public VAPID key — the app fetches this before calling
  // pushManager.subscribe(). Same auth gate as the rest of /api/push, but the
  // value is intentionally non-secret (VAPID public keys are meant to be
  // shared).
  r.get('/vapid-public-key', (_req, res) => {
    const key = getVapidPublicKey();
    if (!key) return res.status(503).json({ error: 'push_not_initialized' });
    return res.json({ publicKey: key });
  });

  // Register a Web Push subscription. Body:
  //   { endpoint: string, keys: { p256dh: string, auth: string } }
  // We store the endpoint as deviceToken (unique constraint fits naturally)
  // and keep p256dh/auth as separate columns for the web-push encryption.
  r.post('/subscribe', async (req, res) => {
    const body = req.body as {
      endpoint?: unknown;
      keys?: { p256dh?: unknown; auth?: unknown };
    };
    if (
      typeof body.endpoint !== 'string' || !body.endpoint ||
      !body.keys ||
      typeof body.keys.p256dh !== 'string' || !body.keys.p256dh ||
      typeof body.keys.auth !== 'string' || !body.keys.auth
    ) {
      return res.status(400).json({ error: 'invalid_subscription' });
    }

    const now = new Date();
    const id = crypto.randomUUID();
    try {
      await db
        .insert(pushDevices)
        .values({
          id,
          deviceToken: body.endpoint,
          platform: 'web',
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: pushDevices.deviceToken,
          set: {
            platform: 'web',
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            lastSeenAt: now,
          },
        })
        .run();
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('POST /api/push/subscribe failed:', e);
      return res.status(500).json({ error: 'internal' });
    }
  });

  // Register a device for push notifications.
  // Body: { deviceToken: string, platform: 'ios' | 'android' }
  // Uses an atomic ON CONFLICT upsert on the unique deviceToken so a
  // re-registration updates lastSeenAt without racing against a concurrent
  // insert.
  r.post('/devices', async (req, res) => {
    const { deviceToken, platform } = req.body as {
      deviceToken?: unknown;
      platform?: unknown;
    };

    if (typeof deviceToken !== 'string' || !deviceToken) {
      return res.status(400).json({ error: 'deviceToken_required_string' });
    }
    if (platform !== 'ios' && platform !== 'android') {
      return res.status(400).json({ error: 'platform_invalid' });
    }
    const plat = platform as Platform;

    const now = new Date();
    const id = crypto.randomUUID();

    try {
      await db
        .insert(pushDevices)
        .values({
          id,
          deviceToken,
          platform: plat,
          lastSeenAt: now,
        })
        .onConflictDoUpdate({
          target: pushDevices.deviceToken,
          set: { platform: plat, lastSeenAt: now },
        })
        .run();
      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('POST /api/push/devices failed:', e);
      return res.status(500).json({ error: 'internal' });
    }
  });

  // Deregister a device by token.
  r.delete('/devices/:token', async (req, res) => {
    const token = req.params.token;
    try {
      await db
        .delete(pushDevices)
        .where(eq(pushDevices.deviceToken, token))
        .run();
      return res.status(204).end();
    } catch (e) {
      console.error('DELETE /api/push/devices/:token failed:', e);
      return res.status(500).json({ error: 'internal' });
    }
  });

  return r;
}
