import type { BroadcastHub } from '../ws/broadcast.js';

/**
 * Route-layer event shape. Emitted by HTTP routes (and later by the scheduler/adapter)
 * to signal something happened. Translated by `broadcastToWs` into the WS-layer
 * `BroadcastEvent` shape before fanning out to subscribers.
 */
export type RouteEvent =
  | { kind: 'run.queued'; issueId: string; runId: string }
  | { kind: 'run.started'; runId: string; issueId: string }
  | { kind: 'run.event'; runId: string; issueId: string; event: unknown }
  | { kind: 'run.finished'; runId: string; issueId: string; exit_code: number }
  | { kind: 'approval.requested'; issueId: string; commentId: string }
  | { kind: 'approval.responded'; issueId: string; value: string };

/**
 * Translate a route-layer event into the WS-layer event shape and fan it out
 * through the hub. Pure function of (hub, msg) — no closures, easy to test.
 */
export function broadcastToWs(hub: BroadcastHub, msg: RouteEvent): void {
  switch (msg.kind) {
    case 'run.queued':
      hub.broadcast({ type: 'run_started', runId: msg.runId, issueId: msg.issueId });
      return;
    case 'run.started':
      hub.broadcast({ type: 'run_started', runId: msg.runId, issueId: msg.issueId });
      return;
    case 'run.event':
      hub.broadcast({
        type: 'run_event',
        runId: msg.runId,
        issueId: msg.issueId,
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
    case 'approval.requested':
      hub.broadcast({ type: 'approval_requested', issueId: msg.issueId, commentId: msg.commentId });
      return;
    case 'approval.responded':
      hub.broadcast({ type: 'approval_responded', issueId: msg.issueId, value: msg.value });
      return;
  }
}