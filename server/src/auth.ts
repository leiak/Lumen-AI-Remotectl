import type { Request, Response, NextFunction, RequestHandler } from 'express';

export function createAuthMiddleware(apiKey: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing_authorization' });
    }
    const token = header.slice('Bearer '.length);
    if (token !== apiKey) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    next();
  };
}

export function generateApiKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return 'sk-' + Buffer.from(bytes).toString('base64url');
}
