import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/**
 * Attaches a UUID request ID to every incoming HTTP request.
 * Respects an incoming X-Request-Id header so callers can trace end-to-end.
 * Echoes the ID in the X-Request-Id response header.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  req.id = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
