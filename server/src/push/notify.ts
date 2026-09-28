/**
 * Push notification dispatch — Web Push (VAPID) for v0.2.
 *
 * Why Web Push and not FCM/APNs:
 *  - Works on iOS Safari 16.4+ and Android Chrome without per-platform SDKs.
 *  - No Apple Developer account ($99/yr) or Firebase project required.
 *  - End-to-end tested by a single browser API and a single `web-push` call.
 *
 * Flow:
 *  1. On first start, generate a VAPID keypair (or use env-supplied keys).
 *     Persist in `settings` so devices re-registering get the same public key.
 *  2. App fetches the public key from `GET /api/push/vapid-public-key` and
 *     calls `pushManager.subscribe(...)`. The resulting PushSubscription is
 *     POSTed to `/api/push/subscribe`.
 *  3. Runner / routes call `notify(db, kind, payload)`. We iterate every
 *     web device and call `web-push.sendNotification`. Failures are logged
 *     but never throw — push is best-effort and must not break the run flow.
 */

import webpush from 'web-push';
import type { Db } from '../db/client.js';
import { pushDevices, settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export type NotifyKind =
  | 'approval_required'
  | 'task_done'
  | 'task_failed'
  | 'mentioned';

export interface NotifyOpts {
  /** Optional override; otherwise read from `settings` or generated on first start. */
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let initialized = false;
let keys: VapidKeys | null = null;

async function loadOrGenerateKeys(db: Db, opts: NotifyOpts): Promise<VapidKeys> {
  if (opts.vapidPublicKey && opts.vapidPrivateKey) {
    return { publicKey: opts.vapidPublicKey, privateKey: opts.vapidPrivateKey };
  }
  // Try persisted keys first so devices that re-subscribe see a stable key.
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'vapidPublicKey'))
    .all();
  if (rows.length === 1) {
    const privRow = await db
      .select()
      .from(settings)
      .where(eq(settings.key, 'vapidPrivateKey'))
      .get();
    if (privRow) {
      return { publicKey: rows[0].value, privateKey: privRow.value };
    }
  }
  // First start: generate and persist.
  const generated = webpush.generateVAPIDKeys();
  const now = new Date();
  await db
    .insert(settings)
    .values({ key: 'vapidPublicKey', value: generated.publicKey, updatedAt: now })
    .onConflictDoNothing()
    .run();
  await db
    .insert(settings)
    .values({ key: 'vapidPrivateKey', value: generated.privateKey, updatedAt: now })
    .onConflictDoNothing()
    .run();
  return generated;
}

export async function initPush(db: Db, opts: NotifyOpts = {}): Promise<void> {
  try {
    keys = await loadOrGenerateKeys(db, opts);
    webpush.setVapidDetails(
      opts.vapidSubject ?? 'mailto:remotectl@localhost',
      keys.publicKey,
      keys.privateKey,
    );
    initialized = true;
    // Stash the public key for the GET /api/push/vapid-public-key handler.
    await db
      .update(settings)
      .set({ value: keys.publicKey, updatedAt: new Date() })
      .where(eq(settings.key, 'vapidPublicKey'))
      .run();
  } catch (e) {
    // Best-effort: never crash the server if VAPID init fails. Devices simply
    // won't get pushes.
    console.warn('VAPID init failed; push notifications disabled:', e);
    initialized = false;
  }
}

export function getVapidPublicKey(): string | null {
  return keys?.publicKey ?? null;
}

export interface NotifyPayload {
  message?: string;
  /** Issue ID the notification refers to — the click handler navigates here. */
  issueId?: string;
  /** Notification kind — for click routing. */
  kind?: string;
  [k: string]: string | undefined;
}

export async function notify(
  db: Db,
  kind: NotifyKind,
  payload: NotifyPayload
): Promise<void> {
  if (!initialized || !keys) return;

  let devices;
  try {
    devices = await db.select().from(pushDevices).all();
  } catch (e) {
    console.error('push: failed to load devices:', e);
    return;
  }

  const title = titleFor(kind);
  const body = payload.message ?? '';
  // Carry the kind + issueId as structured data so the click handler can route.
  // web-push requires string values, so the JSON-stringify the object.
  const data = JSON.stringify({ kind, issueId: payload.issueId ?? null });

  for (const d of devices) {
    if (d.platform !== 'web' || !d.p256dh || !d.auth) continue;
    try {
      await webpush.sendNotification(
        {
          endpoint: d.deviceToken,
          keys: { p256dh: d.p256dh, auth: d.auth },
        },
        JSON.stringify({ title, body, data }),
        { TTL: 60 * 60 }, // 1h — long enough for offline devices
      );
    } catch (e: any) {
      // 404/410 from the push service means the subscription is gone —
      // remove the dead device so we don't keep retrying. Other errors get
      // logged but the device stays registered.
      if (e?.statusCode === 404 || e?.statusCode === 410) {
        try {
          await db
            .delete(pushDevices)
            .where(eq(pushDevices.id, d.id))
            .run();
        } catch {
          // best-effort cleanup
        }
      } else {
        console.error(`push: send failed for device ${d.id}:`, e?.statusCode ?? e?.message ?? e);
      }
    }
  }
}

function titleFor(kind: NotifyKind): string {
  switch (kind) {
    case 'approval_required': return 'Approval needed';
    case 'task_done':         return 'Task done';
    case 'task_failed':       return 'Task failed';
    case 'mentioned':         return 'You were mentioned';
    default:                  return 'Notification';
  }
}

/**
 * Test/debug helper: reset singleton state. Only used by tests.
 */
export function _resetPushForTests(): void {
  initialized = false;
  keys = null;
}

/**
 * Test/debug helper: count registered devices. Used by health checks and
 * acceptance tests so the wiring stays exercised even before push ships.
 */
export async function _deviceCount(db: Db): Promise<number> {
  try {
    const rows = await db.select().from(pushDevices).all();
    return rows.length;
  } catch {
    return 0;
  }
}