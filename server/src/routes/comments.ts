import { Router } from 'express';
import type { Db } from '../db/client.js';
import { createAuthMiddleware } from '../auth.js';

// Comments endpoints live in routes/issues.ts to keep heartbeat-trigger logic colocated.
// This file remains reserved for any future comment-related routes (e.g., approval_response handler).
export function commentsRouter(db: Db, apiKey: string): Router {
  const r = Router();
  r.use(createAuthMiddleware(apiKey));
  return r;
}
