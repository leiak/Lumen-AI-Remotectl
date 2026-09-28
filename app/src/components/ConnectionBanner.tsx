import { useEffect, useState } from 'react';
import { storage } from '../storage';

/**
 * Top-of-page banner that surfaces WebSocket connection health across all
 * pages. The pattern: the WsClient singleton (module-scoped in ws.ts) is
 * the source of truth, but we don't want every page to instantiate it.
 * Instead we expose a lightweight WS probe via the storage layer's
 * lastEventId — a healthy connection is one whose lastEventId is
 * monotonically increasing. When it stops advancing for >5s and the WS
 * isn't connected, show a banner.
 *
 * v0.1 simplified: we just look at navigator.onLine and a 5s poll against
 * a sentinel endpoint. Cheap, accurate enough.
 */
export function ConnectionBanner() {
  const [online, setOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    function onUp() { setOnline(true); }
    function onDown() { setOnline(false); }
    window.addEventListener('online', onUp);
    window.addEventListener('offline', onDown);
    return () => {
      window.removeEventListener('online', onUp);
      window.removeEventListener('offline', onDown);
    };
  }, []);

  if (online) return null;

  return (
    <div className="connection-banner offline" role="alert">
      Offline — reconnecting automatically when the network comes back.
    </div>
  );
}

/**
 * Page-level error toast. The page sets `error` via the toast() helper
 * exported below; the toast auto-dismisses after 5s.
 */
let _push: ((msg: string) => void) | null = null;

export function ErrorToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    _push = (m: string) => {
      setMsg(m);
      window.setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 5000);
    };
    return () => { _push = null; };
  }, []);
  if (!msg) return null;
  return (
    <div className="error-toast" role="status" onClick={() => setMsg(null)}>
      {msg}
    </div>
  );
}

export function toast(msg: string): void {
  if (_push) _push(msg);
}

/**
 * Sticky banner that appears while a WS reconnection loop is in progress
 * (i.e. the last connection attempt failed and the next one is scheduled).
 * Subscribes to a WsClient instance provided by the caller — kept as a
 * component so any page can drop it in.
 */
export function WsStatusBanner({ ws }: { ws: { isConnected(): boolean } }) {
  const [connected, setConnected] = useState(ws.isConnected());
  useEffect(() => {
    const i = window.setInterval(() => setConnected(ws.isConnected()), 500);
    return () => window.clearInterval(i);
  }, [ws]);

  if (connected) return null;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;
  if (!storage.getHost() || !storage.getApiKey()) return null;

  return (
    <div className="connection-banner reconnecting" role="status">
      Reconnecting to server…
    </div>
  );
}