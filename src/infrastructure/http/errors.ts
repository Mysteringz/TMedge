import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ApplicationError } from '../../modules/shared/application/contracts.js';

const STATUS_BY_KIND: Record<ApplicationError['kind'], number> = {
  validation: 400,
  'not-found': 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

/** Forwards rejected Express 4 route promises to error middleware. */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Maps typed application errors without exposing unexpected internals. */
export const applicationErrorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  if (error instanceof ApplicationError) {
    const status = STATUS_BY_KIND[error.kind];
    const message = error.kind === 'internal' ? 'internal server error' : error.message;
    res.status(status).json({ error: message });
    return;
  }
  res.status(500).json({ error: 'internal server error' });
};
