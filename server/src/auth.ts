import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createAuthMiddleware(apiKey: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing_authorization' });
    }
    const token = header.slice('Bearer '.length);
    const a = Buffer.from(token);
    const b = Buffer.from(apiKey);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    next();
  };
}

export function generateApiKey(): string {
  return 'sk-' + randomBytes(24).toString('base64url');
}
