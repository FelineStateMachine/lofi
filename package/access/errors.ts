/** Stable categories for access configuration and collaboration failures. */
export type AccessErrorCode =
  | "configuration"
  | "invalid-identity"
  | "sync-required"
  | "mutation-rejected"
  | "not-found"
  | "invalid-role";

/** Actionable failure raised by access templates and collaboration operations. */
export class AccessError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "AccessError";
  /** Creates an access error without including row contents or secret values. */
  constructor(readonly code: AccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** True when an error came from the lofi access surface. */
export function isAccessError(error: unknown): error is AccessError {
  return error instanceof AccessError;
}
