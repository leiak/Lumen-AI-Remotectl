import { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { WsClient } from '../ws';
import { storage } from '../storage';

interface RunEvent {
  id: number;
  runId: string;
  type: string;
  content: string;
  // Original (unparsed) content for the dev-only "raw" view. Null when the
  // server payload was already a plain string.
  raw: string | null;
}

let eventIdCounter = 0;

/**
 * Translate a Claude stream-json frame into something readable. Returns null
 * for noisy control frames (system/init/keepalive) so the UI doesn't dump
 * raw JSON to the user. `stream-json` events have a few shapes:
 *   - { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
 *   - { type: "result", result: "..." }
 *   - { type: "tool_use", name: "Bash", input: {...} }
 *   - { type: "user", message: { content: [{ type: "tool_result", content: "..." }] } }
 */
function renderableEvent(parsed: any): { type: string; content: string } | null {
  if (!parsed || typeof parsed !== 'object') return null;
  switch (parsed.type) {
    case 'assistant': {
      const blocks: any[] = parsed.message?.content ?? [];
      const texts = blocks
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text);
      if (texts.length === 0) return null;
      return { type: 'assistant', content: texts.join('\n') };
    }
    // Legacy / alternate shape: a flat string in `content` instead of nested
    // `message.content[].text` blocks. Some fixtures and older Claude releases
    // emit this; render it identically so the user sees text either way.
    case 'assistant_text':
      return typeof parsed.content === 'string'
        ? { type: 'assistant', content: parsed.content }
        : null;
    case 'result':
      return typeof parsed.result === 'string'
        ? { type: 'result', content: parsed.result }
        : null;
    case 'tool_use':
      // Show tool name + truncated input summary. The full input lives in the
      // raw panel so we don't render a giant JSON blob inline.
      return { type: 'tool_use', content: parsed.name ?? 'tool' };
    case 'user': {
      const blocks: any[] = parsed.message?.content ?? [];
      const texts = blocks
        .filter((b: any) => b?.type === 'tool_result' && typeof b.content === 'string')
        .map((b: any) => b.content);
      if (texts.length === 0) return null;
      return { type: 'tool_result', content: texts.join('\n') };
    }
    default:
      return null; // system / init / keepalive / unknown — drop
  }
}

export function LiveStream() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [configError, setConfigError] = useState(false);
  // `autoScroll` is true while the user is parked at the bottom — the typical
  // "watch the stream" mode. When they scroll up to read history, we flip it
  // off so new events don't yank them away. They tap "↓ New" to re-anchor.
  const [autoScroll, setAutoScroll] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Refs so the scroll handler can read state without re-subscribing.
  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  // On mount, reset the WS replay cursor so we don't re-render stale events
  // from a previous run on this device. A returning user starting a fresh
  // stream shouldn't see old frames; the server will replay only events
  // produced after the WS connects.
  useEffect(() => {
    storage.setLastEventId(0);
  }, []);

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
        const rawContent = typeof msg.content === 'string' ? msg.content : '';
        let parsed: any = msg.content;
        try { parsed = JSON.parse(msg.content); } catch { /* keep as string */ }
        const ev = renderableEvent(parsed);
        if (!ev) return; // drop noisy system/init/keepalive frames
        setEvents((prev) => [
          ...prev,
          {
            id: ++eventIdCounter,
            runId: msg.runId,
            type: ev.type,
            content: ev.content,
            raw: rawContent,
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

  // Scroll to bottom whenever new events arrive — but only if the user is
  // already anchored. Reading the ref lets us do this without making the
  // handler itself a stale closure over `autoScroll`.
  useEffect(() => {
    if (!autoScrollRef.current) return;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events]);

  // Detect scroll direction: if the user is within ~24px of the bottom they
  // count as "parked" — keep auto-scroll on. Otherwise they're reading
  // history and we let them stay there.
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distFromBottom < 24);
  }, []);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  }, []);

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
      <div className="livestream-header">
        <h2>📺 Live · #{id.slice(0, 8)}</h2>
        <div className="livestream-meta">
          <span className={`ws-status ws-${status}`}>● {status}</span>
          <span className="muted">{events.length} events</span>
          <button
            type="button"
            className="secondary small"
            onClick={() => setShowRaw((v) => !v)}
            aria-pressed={showRaw}
            title="Toggle raw JSON view"
          >
            {showRaw ? 'Hide raw' : 'Show raw'}
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="stream"
        onScroll={onScroll}
      >
        {events.length === 0 ? (
          <div className="stream-empty">
            <p>Waiting for events…</p>
            <p className="muted">Stream is live but no output yet. Run a task or send a comment to trigger Claude.</p>
          </div>
        ) : (
          events.map((e) => (
            <div key={e.id} className={`stream-event stream-${e.type}`}>
              <div className="stream-event-head">
                <span className={`event-tag event-tag-${e.type}`}>{e.type}</span>
              </div>
              <div className="stream-event-body">{e.content}</div>
              {showRaw && e.raw && (
                <pre className="stream-event-raw">{e.raw}</pre>
              )}
            </div>
          ))
        )}
      </div>
      {!autoScroll && events.length > 0 && (
        <button
          type="button"
          className="jump-bottom primary small"
          onClick={jumpToBottom}
        >
          ↓ New
        </button>
      )}
    </div>
  );
}