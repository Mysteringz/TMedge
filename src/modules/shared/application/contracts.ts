/** Identifies the actor responsible for an application operation. */
export interface Actor {
  id: string;
  kind: 'console' | 'system' | 'student';
}

/** Stable categories for application failures before transport mapping. */
export type ApplicationErrorKind = 'validation' | 'not-found' | 'conflict' | 'unavailable' | 'internal';

/** Framework-free application error with a transport-independent category. */
export class ApplicationError extends Error {
  constructor(readonly kind: ApplicationErrorKind, message: string) {
    super(message);
    this.name = 'ApplicationError';
  }
}
