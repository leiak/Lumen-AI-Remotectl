import { Router } from 'express';
import type { Db } from '../db/client.js';
import { createAuthMiddleware } from '../auth.js';

// Empty for now — comments routes live in issues router.
// This file will host the heartbeat trigger logic in Task 5.
export function commentsRouter(db: Db, apiKey: string = 'sk-test'): Router {
  const r = Router();
  r.use(createAuthMiddleware(apiKey));
  return r;
}