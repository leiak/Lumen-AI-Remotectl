/**
 * Client-side push notification registration helper.
 *
 * This module is intentionally defensive:
 *  - It must not crash the app if `@capacitor/push-notifications` is not
 *    installed (e.g. during `vite build` for the web, or in tests).
 *  - It must be a no-op on non-native platforms (web).
 *  - It must always return `{ token, error }` and never throw.
 *
 * On iOS/Android it requests permission, registers with APNs/FCM, and
 * resolves with the resulting device token (or an error).
 */
export type RegisterPushResult = {
  token: string | null;
  error: string | null;
};

export async function registerPush(): Promise<RegisterPushResult> {
  // Try to load Capacitor + the push-notifications plugin. If either import
  // fails (missing package, web build, test environment), we return a
  // structured error instead of throwing.
  let Capacitor: any;
  let PushNotifications: any;
  try {
    // Dynamic imports so this module can be loaded in any environment
    // without hard-failing at module-eval time.
    const capMod = await import('@capacitor/core');
    Capacitor = (capMod as any).Capacitor ?? capMod.default ?? capMod;

    // @ts-ignore — `@capacitor/push-notifications` is an optional dependency.
    // The try/catch below turns a missing package into a graceful error
    // result instead of crashing app startup.
    const pnMod = await import('@capacitor/push-notifications');
    PushNotifications = (pnMod as any).PushNotifications ?? pnMod.default ?? pnMod;
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

    return await new Promise<RegisterPushResult>((resolve) => {
      let settled = false;
      const finish = (r: RegisterPushResult) => {
        if (settled) return;
        settled = true;
        // Best-effort cleanup; if removeAllListeners isn't available we just
        // leave listeners attached — the next register() call will overwrite.
        try {
          PushNotifications.removeAllListeners?.('registration');
          PushNotifications.removeAllListeners?.('registrationError');
        } catch {}
        resolve(r);
      };

      try {
        PushNotifications.addListener('registration', (t: { value: string }) => {
          finish({ token: t.value, error: null });
        });
        PushNotifications.addListener('registrationError', (e: unknown) => {
          finish({ token: null, error: String(e) });
        });
      } catch (e) {
        finish({ token: null, error: e instanceof Error ? e.message : String(e) });
      }
    });
  } catch (e) {
    return { token: null, error: e instanceof Error ? e.message : String(e) };
  }
}
