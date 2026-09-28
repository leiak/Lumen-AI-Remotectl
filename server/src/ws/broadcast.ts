import { WebSocket } from 'ws';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { broadcastLog } from '../db/schema.js';

/** Best-effort delivery: no retries, no buffering. Subscribers must be idempotent. */
export type BroadcastEvent =
  | { type: 'issue_updated'; issueId: string; status: string }
  | { type: 'run_started'; runId: string; issueId: string }
  | { type: 'run_event'; runId: string; issueId: string; stream: 'stdout' | 'stderr'; content: string }
  | { type: 'run_finished'; runId: string; issueId: string; status: 'done' | 'failed' | 'cancelled'; error?: string }
  | { type: 'approval_requested'; issueId: string; commentId: string }
  | { type: 'approval_responded'; issueId: string; value: string }
  | { type: 'comment_deleted'; issueId: string; commentId: string };

/**
 * Wraps a broadcast payload with the monotonic `event_id` assigned at insert
 * time. Clients persist the highest id they've seen and pass it back as
 * `?since=<id>` on reconnect so the hub can replay missed frames.
 */
export interface BroadcastEnvelope {
  event_id: number;
  event: BroadcastEvent;
}

export class BroadcastHub {
  private sockets = new Set<WebSocket>();

  constructor(private db: Db) {}

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
  }

  /**
   * Fan-out a broadcast event to all connected sockets AND persist it to the
   * broadcast log so a reconnecting client can replay missed events. The
   * envelope's `event_id` is the autoincrement row id from the log.
   *
   * Fire-and-forget: returns synchronously and schedules the persist+fan-out
   * on the next microtask. The live broadcast has a one-tick delay so we can
   * attach a real `event_id` (the previous sync fallback shipped two frames
   * per event — first with id=0, then with the real id — which broke
   * client-side monotonic bookkeeping).
   */
  broadcast(event: BroadcastEvent): Promise<void> {
    return this.persistAndFanout(event);
  }

  private async persistAndFanout(event: BroadcastEvent): Promise<void> {
    try {
      await this.db.insert(broadcastLog).values({
        eventType: event.type,
        payload: JSON.stringify(event),
        createdAt: new Date(),
      }).run();
      // last_insert_rowid() is connection-local and only valid before any
      // other statement runs on the same connection. Reading on the same
      // async queue as the insert keeps the autoincrement id coherent.
      const rows = await this.db.all<{ id: number }>(
        `SELECT last_insert_rowid() AS id`,
      );
      const last = rows[0];
      if (!last || typeof last.id !== 'number') {
        console.error('[broadcast] missing last_insert_rowid');
        return;
      }
      const env: BroadcastEnvelope = { event_id: last.id, event };
      const msg = JSON.stringify(env);
      for (const ws of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    } catch (err) {
      console.error('[broadcast] log insert failed:', err);
      // Fall back to a no-id fan-out so live UI still works even if the log
      // write is broken (e.g. DB locked). The client treats event_id=0 as
      // "don't persist this as the high-water mark".
      const msg = JSON.stringify({ event_id: 0, event });
      for (const ws of this.sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    }
  }

  /**
   * Return all broadcast events with id > since, in order. Called by the WS
   * upgrade handler when a client reconnects with `?since=<id>` so the live
   * stream picks up where the phone left off.
   */
  async replaySince(since: number): Promise<BroadcastEnvelope[]> {
    try {
      // Drizzle's `.all()` accepts a `SQLWrapper` for parameterized queries
      // (raw string params aren't supported — that would invite SQL injection
      // and bind-format drift). Use the `sql` tagged template so `since` is
      // bound safely. For small log sizes a single SELECT is fine; if it
      // ever grows we can paginate with `id > since LIMIT N` cursors.
      const rows = await this.db.all<{ id: number; payload: string }>(
        sql`SELECT id, payload FROM broadcast_log WHERE id > ${since} ORDER BY id ASC`,
      );
      const out: BroadcastEnvelope[] = [];
      for (const r of rows) {
        try {
          const event = JSON.parse(r.payload) as BroadcastEvent;
          out.push({ event_id: r.id, event });
        } catch {
          // skip malformed row
        }
      }
      return out;
    } catch (err) {
      console.error('[broadcast] replay failed:', err);
      return [];
    }
  }

  size(): number {
    return this.sockets.size;
  }
}