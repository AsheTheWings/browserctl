// Failures with a stable, low-cardinality class that telemetry, MCP results, and HTTP answers share.

export type ErrorClass =
  | 'capacity'
  | 'invalid_request'
  | 'not_found'
  | 'unauthorized'
  | 'conflict'
  | 'provider_unreachable'
  | 'provider_unauthorized'
  | 'provider_error'
  | 'lease_lost'
  | 'browser_failed'
  | 'timeout'
  | 'task_failed'
  | 'model_unavailable'
  | 'internal';

/** An error whose message is safe to show its caller: it never holds a token, path secret, or page content. */
export class BrowserctlError extends Error {
  readonly errorClass: ErrorClass;
  constructor(errorClass: ErrorClass, message: string, options?: ErrorOptions) {
    super(message, options);
    this.errorClass = errorClass;
  }
}

export function errorClassOf(error: unknown): ErrorClass {
  return error instanceof BrowserctlError ? error.errorClass : 'internal';
}

/** The message a caller may see: a BrowserctlError's own, otherwise a generic one. */
export function publicMessage(error: unknown): string {
  return error instanceof BrowserctlError ? error.message : 'internal error';
}
