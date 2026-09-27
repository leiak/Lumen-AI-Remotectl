import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WsClient } from '../ws';
import { storage } from '../storage';

interface RunEvent {
  id: number;
  runId: string;
  type: string;
  content: string;
}

let eventIdCounter = 0;

export function LiveStream() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [configError, setConfigError] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!id) return;

    // Surface a friendly "settings not configured" state instead of an
    // eternal spinner when the user hasn't set up host/apiKey yet.
    if (!storage.getHost() || !storage.getApiKey()) {
      setStatus('disconnected');
      setConfigError(true);
      return;
    }

    let cancelled = false;
    const ws = new WsClient({ baseBackoffMs: 500, maxBackoffMs: 5000 });
    const unsub = ws.onMessage((msg: any) => {
      // The cleanup function flips `cancelled` BEFORE React tears down this
      // effect; if a queued ws message then calls setEvents, React will warn
      // about a state update on an unmounted component. Guard explicitly so
      // late-arriving frames from the reconnect backlog are dropped.
      if (cancelled) return;
      // Only render events for the issue this page is bound to. Without this
      // filter, a user viewing Issue A's stream would see Issue B's stdout.
      if (msg.type === 'run_event' && msg.runId && msg.issueId === id) {
        let parsed: any = msg.content;
        try { parsed = JSON.parse(msg.content); } catch { /* keep as string */ }
        setEvents((prev) => [
          ...prev,
          {
            id: ++eventIdCounter,
            runId: msg.runId,
            type: parsed?.type ?? 'unknown',
            content: typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed),
          },
        ]);
      }
    });
    ws.connect();

    // Poll connection status via isConnected()
    const interval = setInterval(() => {
      setStatus(ws.isConnected() ? 'connected' : 'disconnected');
    }, 500);

    return () => {
      cancelled = true;
      clearInterval(interval);
      unsub();
      ws.disconnect();
    };
  }, [id]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events]);

  if (!id) return <div className="page livestream"><h2>Live Stream</h2><p>Missing id.</p></div>;

  if (configError) {
    return (
      <div className="page livestream not-configured">
        <h2>📺 Live · #{id.slice(0, 8)}</h2>
        <p>Not connected. Go to <Link to="/settings">Settings</Link> to configure host and API key.</p>
      </div>
    );
  }

  return (
    <div className="page livestream">
      <h2>📺 Live · #{id.slice(0, 8)}</h2>
      <div className="muted">● {status} · {events.length} events</div>
      <div ref={scrollRef} className="stream">
        {events.map((e) => (
          <div key={e.id} className={`stream-event stream-${e.type}`}>
            <span className="event-type">[{e.type}]</span> {e.content}
          </div>
        ))}
      </div>
    </div>
  );
}