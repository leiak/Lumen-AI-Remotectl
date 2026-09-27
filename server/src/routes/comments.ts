import { Router } from 'express';
import type { Db } from '../db/client.js';
import { createAuthMiddleware } from '../auth.js';

// Placeholder for Task 5 heartbeat trigger logic.
// Currently empty — comments routes live in issues.ts.
export function commentsRouter(db: Db, apiKey: string): Router {
  const r = Router();
  r.use(createAuthMiddleware(apiKey));
  return r;
}
