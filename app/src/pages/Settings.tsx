import { useEffect, useRef, useState } from 'react';
import { useApi } from '../api/context';
import { fmtError } from '../api/client';
import { storage } from '../storage';
import { registerPush, registerWebPush, unregisterWebPush } from '../push';

// `Capacitor` is an optional native runtime — present only when the iOS /
// Android shell is loaded. We hide it behind a string var so the web build
// (which has no Capacitor installed) doesn't fail to resolve the import.
async function isNativePlatform(): Promise<boolean> {
  try {
    const coreSpec = '@capacitor/core';
    const mod: any = await import(/* @vite-ignore */ coreSpec);
    const Cap = mod?.Capacitor ?? mod?.default ?? mod;
    return typeof Cap?.isNativePlatform === 'function' && Cap.isNativePlatform();
  } catch {
    return false;
  }
}

async function getNativePlatform(): Promise<'ios' | 'android' | null> {
  try {
    const coreSpec = '@capacitor/core';
    const mod: any = await import(/* @vite-ignore */ coreSpec);
    const Cap = mod?.Capacitor ?? mod?.default ?? mod;
    const p = typeof Cap?.getPlatform === 'function' ? Cap.getPlatform() : null;
    return p === 'ios' || p === 'android' ? p : null;
  } catch {
    return null;
  }
}

export function Settings() {
  const api = useApi();
  const [host, setHost] = useState<string>(() => storage.getHost() ?? '');
  const [apiKey, setApiKey] = useState<string>(() => storage.getApiKey() ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [pushState, setPushState] = useState<'unknown' | 'off' | 'on' | 'unsupported'>('unknown');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  // Track the "Saved" indicator timer so rapid Save clicks don't leave dangling
  // timers, and unmount clears the in-flight timer.
  const savedTimerRef = useRef<number | null>(null);

  function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setTestResult(null);
    storage.setHost(host.trim());
    storage.setApiKey(apiKey.trim());
    setSaved(true);
    // Hide the saved indicator after a short delay so the UI doesn't feel sticky.
    if (savedTimerRef.current !== null) {
      window.clearTimeout(savedTimerRef.current);
    }
    savedTimerRef.current = window.setTimeout(() => {
      setSaved(false);
      savedTimerRef.current = null;
    }, 2000);
  }

  useEffect(() => {
    return () => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
        savedTimerRef.current = null;
      }
    };
  }, []);

  // Probe current Web Push state on mount so the button can show "Disable"
  // when already subscribed. iOS Safari 16.4+ supports Push API only after the
  // PWA is added to the home screen — we surface that hint when we can.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        if (!cancelled) setPushState('unsupported');
        return;
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration('/sw.js');
        if (!reg) { if (!cancelled) setPushState('off'); return; }
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setPushState(sub ? 'on' : 'off');
      } catch {
        if (!cancelled) setPushState('off');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function onTogglePush() {
    if (pushBusy) return;
    setPushBusy(true);
    setPushMsg(null);
    const baseUrl = host.trim();
    const key = apiKey.trim();
    try {
      if (pushState === 'on') {
        await unregisterWebPush(baseUrl, key);
        setPushState('off');
        setPushMsg('Notifications disabled.');
      } else {
        const native = await isNativePlatform();
        if (native) {
          const platform = (await getNativePlatform()) ?? 'ios';
          const r = await registerPush({ apiBaseUrl: baseUrl, apiKey: key, platform });
          if (r.token) {
            setPushState('on');
            setPushMsg(
              r.error
                ? `Notifications enabled (token saved; server sync issue: ${r.error}).`
                : 'Notifications enabled.',
            );
          } else {
            setPushMsg(`Error: ${r.error ?? 'unknown'}`);
          }
        } else {
          const r = await registerWebPush(baseUrl, key);
          if (r.ok) {
            setPushState('on');
            setPushMsg('Notifications enabled.');
          } else {
            // iOS Safari reports push as unavailable until the app is on the
            // home screen — give the user an actionable hint when so.
            const hint = /not[_ ]?supported/i.test(r.error ?? '')
              ? ' (iOS: add to Home Screen first)'
              : '';
            setPushMsg(`Error: ${r.error}${hint}`);
          }
        }
      }
    } finally {
      setPushBusy(false);
    }
  }

  async function onTest() {
    setError(null);
    setTestResult(null);
    setTesting(true);
    // Persist first so the next ApiClient construction (or refresh) sees the new values.
    storage.setHost(host.trim());
    storage.setApiKey(apiKey.trim());
    try {
      const issues = await api.listIssues();
      setTestResult(`Connected — ${issues.length} issue${issues.length === 1 ? '' : 's'}`);
    } catch (e) {
      setError(fmtError(e));
    } finally {
      setTesting(false);
    }
  }

  const hasValues = host.trim().length > 0 && apiKey.trim().length > 0;

  return (
    <div className="page settings">
      <h2>Settings</h2>
      {error && <p className="form-error">Error: {error}</p>}
      {saved && <p className="settings-saved">Saved ✓</p>}
      {testResult && <p className="settings-test-result">{testResult}</p>}
      <form onSubmit={onSave} className="settings-form">
        <label className="field">
          <span className="field-label">Server URL</span>
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="http://100.x.x.x:3100"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span className="field-label">API Key</span>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="settings-actions">
          <button
            type="button"
            onClick={onTest}
            disabled={!hasValues || testing}
            className="secondary"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button
            type="submit"
            className="primary"
          >
            Save
          </button>
        </div>
      </form>

      <section className="settings-section">
        <h3>Push notifications</h3>
        {pushState === 'unsupported' ? (
          <p className="muted">This browser does not support Web Push.</p>
        ) : (
          <>
            <p className="muted">
              {pushState === 'on'
                ? 'Notifications are enabled for this device.'
                : 'Get notified when Claude finishes, fails, or needs approval.'}
            </p>
            <button
              type="button"
              onClick={onTogglePush}
              disabled={pushBusy || !hasValues}
              className={pushState === 'on' ? 'secondary' : 'primary'}
            >
              {pushBusy ? '…' : pushState === 'on' ? 'Disable notifications' : 'Enable notifications'}
            </button>
            {pushMsg && <p className="settings-test-result">{pushMsg}</p>}
          </>
        )}
      </section>
    </div>
  );
}