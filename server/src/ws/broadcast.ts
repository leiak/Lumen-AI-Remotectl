import { WebSocket } from 'ws';

/** Best-effort delivery: no retries, no buffering. Subscribers must be idempotent. */
export type BroadcastEvent =
  | { type: 'issue_updated'; issueId: string; status: string }
  | { type: 'run_started'; runId: string; issueId: string }
  | { type: 'run_event'; runId: string; issueId: string; stream: 'stdout' | 'stderr'; content: string }
  | { type: 'run_finished'; runId: string; status: 'done' | 'failed' | 'cancelled'; error?: string }
  | { type: 'approval_requested'; issueId: string; commentId: string }
  | { type: 'approval_responded'; issueId: string; value: string };

export class BroadcastHub {
  private sockets = new Set<WebSocket>();

  attach(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
  }

  broadcast(event: BroadcastEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  size(): number {
    return this.sockets.size;
  }
}