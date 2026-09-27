import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WsClient } from '../ws';

interface RunEvent {
  id: number;
  runId: string;
  type: string;
  content: string;
}

export function LiveStream() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WsClient | null>(null);

  useEffect(() => {
    if (!id) return;
    const ws = new WsClient({ baseBackoffMs: 500, maxBackoffMs: 5000 });
    wsRef.current = ws;
    const unsub = ws.onMessage((msg: any) => {
      if (msg.type === 'run_event' && msg.runId && id) {
        // parse the inner event JSON
        let parsed: any = msg.content;
        try { parsed = JSON.parse(msg.content); } catch { /* keep as string */ }
        setEvents((prev) => [
          ...prev,
          {
            id: Date.now() + Math.random(),
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
      clearInterval(interval);
      unsub();
      ws.disconnect();
    };
  }, [id]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events]);

  if (!id) return <div className="page livestream"><h2>Live Stream</h2><p>Missing id.</p></div>;

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
