import type { RequestHandler } from 'express';
import { ApplicationError } from '../../modules/shared/application/contracts.js';

export type InputValidator<T> = (value: unknown) => T;

/** Validates the request body before a route invokes application work. */
export function validateBody<T>(validate: InputValidator<T>): RequestHandler {
  return (request, response, next) => {
    try {
      response.locals.validatedBody = validate(request.body);
      next();
    } catch (error: unknown) {
      next(error instanceof ApplicationError ? error : new ApplicationError('validation', 'invalid request'));
    }
  };
}

/** Requires a plain object body and returns it for feature-specific checks. */
export function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApplicationError('validation', 'request body must be an object');
  }
  return value as Record<string, unknown>;
}
