import type { BroadcastHub } from '../ws/broadcast.js';

/**
 * Route-layer event shape. Emitted by HTTP routes (and later by the scheduler/adapter)
 * to signal something happened. Translated by `broadcastToWs` into the WS-layer
 * `BroadcastEvent` shape before fanning out to subscribers.
 */
export type RouteEvent =
  | { kind: 'run.queued'; issueId: string; runId: string }
  | { kind: 'run.event'; runId: string; issue_id: string; event: unknown }
  | { kind: 'run.finished'; runId: string; issue_id: string; exit_code: number };

/**
 * Translate a route-layer event into the WS-layer event shape and fan it out
 * through the hub. Pure function of (hub, msg) — no closures, easy to test.
 */
export function broadcastToWs(hub: BroadcastHub, msg: RouteEvent): void {
  switch (msg.kind) {
    case 'run.queued':
      hub.broadcast({ type: 'run_started', runId: msg.runId, issueId: msg.issueId });
      return;
    case 'run.event':
      hub.broadcast({
        type: 'run_event',
        runId: msg.runId,
        stream: 'stdout',
        content: JSON.stringify(msg.event),
      });
      return;
    case 'run.finished':
      hub.broadcast({
        type: 'run_finished',
        runId: msg.runId,
        status: msg.exit_code === 0 ? 'done' : 'failed',
      });
      return;
  }
}