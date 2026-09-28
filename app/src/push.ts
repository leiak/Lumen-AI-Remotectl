/**
 * Client-side push notification helpers.
 *
 * Two parallel paths:
 *  - `registerPush()` — Capacitor native path (iOS/Android APNs/FCM).
 *    Defensive: never crashes if `@capacitor/push-notifications` is missing
 *    (e.g. web build, tests).
 *  - `registerWebPush()` / `unregisterWebPush()` — browser Web Push path
 *    using a service worker and the Push API. Works on iOS Safari 16.4+
 *    (after the app is added to home screen) and Android Chrome.
 *
 * Both paths always resolve with a structured `{ ok, error }` so the UI can
 * branch on the outcome without try/catching.
 */

export type RegisterPushResult = {
  token: string | null;
  error: string | null;
};

export type RegisterNativePushOpts = {
  apiBaseUrl: string;
  apiKey: string;
  platform?: 'ios' | 'android';
};

/**
 * After APNs/FCM hands us a device token, hand it off to the server so it can
 * push to us. Best-effort: a server failure must not surface as a "push
 * registration failed" to the user — the OS already accepted the token, the
 * UI just won't get notifications until the server is reachable.
 */
async function postDeviceToken(
  apiBaseUrl: string,
  apiKey: string,
  deviceToken: string,
  platform: 'ios' | 'android',
): Promise<string | null> {
  try {
    const res = await fetch(`${apiBaseUrl}/api/push/devices`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ deviceToken, platform }),
    });
    if (!res.ok) return `server_subscribe_failed: ${res.status}`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export type WebPushRegisterResult = {
  ok: boolean;
  error: string | null;
};

// --- Capacitor native path -----------------------------------------------

export async function registerPush(
  opts: RegisterNativePushOpts = { apiBaseUrl: '', apiKey: '' },
): Promise<RegisterPushResult> {
  let Capacitor: any;
  let PushNotifications: any;
  try {
    // `@capacitor/*` are optional peer deps — present only in the native
    // build. We hide the specifiers behind string variables so Vite's static
    // import analysis can't see them at build/test time. `as any` keeps TS
    // happy too.
    const coreSpec = '@capacitor/core';
    const capMod = await import(/* @vite-ignore */ coreSpec) as any;
    Capacitor = capMod?.Capacitor ?? capMod?.default ?? capMod;
    const pushSpec = '@capacitor/push-notifications';
    const pnMod = await import(/* @vite-ignore */ pushSpec) as any;
    PushNotifications = pnMod?.PushNotifications ?? pnMod?.default ?? pnMod;
  } catch (e) {
    return {
      token: null,
      error: `capacitor_unavailable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!Capacitor || !PushNotifications) {
    return { token: null, error: 'capacitor_unavailable' };
  }

  if (typeof Capacitor.isNativePlatform === 'function' && !Capacitor.isNativePlatform()) {
    return { token: null, error: 'not_native_platform' };
  }

  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm?.receive !== 'granted') {
      return { token: null, error: 'permission_denied' };
    }

    await PushNotifications.register();

    const REGISTRATION_TIMEOUT_MS = 10_000;
    const result = await Promise.race([
      new Promise<RegisterPushResult>((resolve) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const off1: any = PushNotifications.addListener('registration', (t: { value: string }) => {
          resolve({ token: t.value, error: null });
          try { off1.remove(); } catch {}
          try { off2.remove(); } catch {}
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const off2: any = PushNotifications.addListener('registrationError', (e: unknown) => {
          resolve({ token: null, error: String(e) });
          try { off1.remove(); } catch {}
          try { off2.remove(); } catch {}
        });
      }),
      new Promise<RegisterPushResult>((resolve) =>
        setTimeout(
          () => resolve({ token: null, error: 'registration_timeout' }),
          REGISTRATION_TIMEOUT_MS,
        ),
      ),
    ]);

    if (result.token && opts.apiBaseUrl && opts.apiKey) {
      const platform = opts.platform ?? 'ios';
      const serverErr = await postDeviceToken(
        opts.apiBaseUrl,
        opts.apiKey,
        result.token,
        platform,
      );
      if (serverErr) {
        // The OS already accepted the token — preserve it for retry, but
        // surface the server-side error so the UI can explain why pushes
        // aren't arriving yet.
        return { token: result.token, error: `token_obtained_but_${serverErr}` };
      }
    }

    return result;
  } catch (e) {
    return { token: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- Web Push (browser) path ---------------------------------------------

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export async function registerWebPush(
  apiBaseUrl: string,
  apiKey: string,
): Promise<WebPushRegisterResult> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return { ok: false, error: 'web_push_not_supported' };
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: 'permission_denied' };

    const reg = await navigator.serviceWorker.register('/sw.js');

    const keyRes = await fetch(`${apiBaseUrl}/api/push/vapid-public-key`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!keyRes.ok) return { ok: false, error: `vapid_key_fetch_failed: ${keyRes.status}` };
    const { publicKey } = (await keyRes.json()) as { publicKey: string };

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
    }

    const subJson = sub.toJSON();
    const endpoint = subJson.endpoint;
    const p256dh = subJson.keys?.p256dh;
    const auth = subJson.keys?.auth;
    if (!endpoint || !p256dh || !auth) {
      return { ok: false, error: 'subscription_incomplete' };
    }

    const regRes = await fetch(`${apiBaseUrl}/api/push/subscribe`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ endpoint, keys: { p256dh, auth } }),
    });
    if (!regRes.ok) return { ok: false, error: `subscribe_failed: ${regRes.status}` };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function unregisterWebPush(
  apiBaseUrl: string,
  apiKey: string,
): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await fetch(
      `${apiBaseUrl}/api/push/devices/${encodeURIComponent(endpoint)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${apiKey}` } },
    ).catch(() => undefined);
  } catch {
    // best-effort
  }
}