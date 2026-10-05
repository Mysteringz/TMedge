import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler } from 'express';
import type { StudentActivityLog } from '../../modules/student-auth/application/student-activity-log.js';
import { applicationErrorHandler } from '../http/errors.js';

/** Preserve parser status codes while excluding body-parser's raw request/error details. */
export function studentHttpErrorHandler(activity?: StudentActivityLog): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    const type = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
    let status: number | undefined;
    if (type === 'entity.parse.failed' || type === 'request.aborted') status = 400;
    else if (type === 'entity.too.large') status = 413;
    else if (type === 'encoding.unsupported' || type === 'charset.unsupported') status = 415;
    if (status) {
      if (req.path === '/login' || req.path === '/signup') activity?.record(req.path === '/login' ? 'login' : 'signup', 'failed', null, randomUUID());
      res.status(status).json({ error: status === 413 ? 'request body too large' : status === 415 ? 'unsupported body encoding' : 'invalid request body' });
      return;
    }
    applicationErrorHandler(error, req, res, next);
  };
}
