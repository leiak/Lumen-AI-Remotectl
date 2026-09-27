import { describe, it, expect, vi } from 'vitest';
import { createAuthMiddleware } from '../auth.js';

describe('auth middleware', () => {
  it('rejects requests without Authorization header', () => {
    const mw = createAuthMiddleware('sk-test-123');
    const req = { headers: {} } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects requests with wrong token', () => {
    const mw = createAuthMiddleware('sk-test-123');
    const req = { headers: { authorization: 'Bearer sk-wrong' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('accepts requests with correct token', () => {
    const mw = createAuthMiddleware('sk-test-123');
    const req = { headers: { authorization: 'Bearer sk-test-123' } } as any;
    const res = { status: vi.fn() } as any;
    const next = vi.fn();
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
