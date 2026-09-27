/**
 * Push notification dispatch.
 *
 * MVP behavior:
 *  - initPush() optionally loads firebase-admin when FCM credentials are supplied.
 *    If init fails (missing package, bad credentials, etc.) we log and continue —
 *    push is best-effort and must never break the server.
 *  - notify() iterates every registered device and sends a notification.
 *    Each per-device send is wrapped in try/catch so one bad device cannot
 *    poison the whole batch.
 *  - iOS / APNs is not implemented in this MVP — see TODO(iOS).
 */

import type { Db } from '../db/client.js';
import { pushDevices } from '../db/schema.js';

export type NotifyKind =
  | 'approval_required'
  | 'task_done'
  | 'task_failed'
  | 'mentioned';

export interface NotifyOpts {
  fcmCredentialsPath?: string;
  apnKeyPath?: string;
}

let fcmInitialized = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fcmAdmin: any = null;

export async function initPush(opts: NotifyOpts): Promise<void> {
  if (opts.fcmCredentialsPath) {
    try {
      // Dynamic import keeps firebase-admin optional — installing the package
      // is not required to run the server (or the tests).
      const mod = await import('firebase-admin');
      const admin = mod.default ?? mod;
      if (typeof admin.initializeApp === 'function') {
        admin.initializeApp({
          credential: admin.credential.cert(opts.fcmCredentialsPath),
        });
      }
      fcmAdmin = admin;
      fcmInitialized = true;
    } catch (e) {
      // Best-effort: never crash the server if FCM init fails.
      console.warn('FCM init failed; push notifications disabled:', e);
      fcmInitialized = false;
      fcmAdmin = null;
    }
  }
  // TODO(iOS): implement APNs init via the `apn` package when needed.
  void opts.apnKeyPath;
}

export interface NotifyPayload {
  message?: string;
  [k: string]: string | undefined;
}

export async function notify(
  db: Db,
  kind: NotifyKind,
  payload: NotifyPayload
): Promise<void> {
  let devices;
  try {
    devices = await db.select().from(pushDevices).all();
  } catch (e) {
    console.error('push: failed to load devices:', e);
    return;
  }

  const title = titleFor(kind);

  for (const d of devices) {
    try {
      if (d.platform === 'android' && fcmInitialized && fcmAdmin) {
        await fcmAdmin.messaging().send({
          token: d.deviceToken,
          notification: { title, body: payload.message ?? '' },
          data: stringifyData(payload),
        });
      } else if (d.platform === 'ios') {
        console.warn('push: iOS dispatch not implemented; skipping device', d.id);
      }
      // 'web' is not part of the schema enum today; if it ever is, add a
      // branch here for web push (e.g. via web-push / VAPID).
    } catch (e) {
      // Never let one failing device break the batch.
      console.error(`push: send failed for device ${d.id}:`, e);
    }
  }
}

function stringifyData(p: NotifyPayload): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
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
 * Test/debug helper: reset the singleton state. Only used by tests.
 */
export function _resetPushForTests(): void {
  fcmInitialized = false;
  fcmAdmin = null;
}
