import { Router } from 'express';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { pushDevices } from '../db/schema.js';
import { createAuthMiddleware } from '../auth.js';

const ALLOWED_PLATFORMS = ['ios', 'android'] as const;
type Platform = typeof ALLOWED_PLATFORMS[number];

export function pushRouter(db: Db, apiKey: string): Router {
  const r = Router();
  r.use(createAuthMiddleware(apiKey));

  // Register a device for push notifications.
  // Body: { deviceToken: string, platform: 'ios' | 'android' }
  // Upserts on the unique deviceToken so a re-registration updates lastSeenAt
  // instead of failing the UNIQUE constraint.
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

    try {
      // First, see if this token is already registered.
      const existing = await db
        .select()
        .from(pushDevices)
        .where(eq(pushDevices.deviceToken, deviceToken))
        .get();

      if (existing) {
        await db
          .update(pushDevices)
          .set({ platform: plat, lastSeenAt: now })
          .where(eq(pushDevices.id, existing.id))
          .run();
        return res.status(200).json({ ok: true, id: existing.id, updated: true });
      }

      const id = crypto.randomUUID();
      await db
        .insert(pushDevices)
        .values({
          id,
          deviceToken,
          platform: plat,
          lastSeenAt: now,
        })
        .run();
      return res.status(201).json({ ok: true, id, created: true });
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
