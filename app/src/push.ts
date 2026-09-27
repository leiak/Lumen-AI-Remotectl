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

    // @ts-expect-error — `@capacitor/push-notifications` is an optional peer dep.
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

    // Race the registration listeners against a 10s timeout. Capacitor's
    // `addListener` returns a `PluginListenerHandle` with `.remove()`, which
    // we use to unsubscribe on first resolution — avoiding a dangling listener
    // holding a reference to the promise.
    const REGISTRATION_TIMEOUT_MS = 10_000;
    const result = await Promise.race([
      new Promise<RegisterPushResult>((resolve) => {
        // `PushNotifications` is typed as `any` (optional peer dep), so the
        // listener-handle types aren't statically known. Cast to `any` so the
        // `.remove()` calls below type-check even when the mock plugin
        // returns a different shape.
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
        setTimeout(() => resolve({ token: null, error: 'registration_timeout' }), REGISTRATION_TIMEOUT_MS),
      ),
    ]);
    return result;
  } catch (e) {
    return { token: null, error: e instanceof Error ? e.message : String(e) };
  }
}
