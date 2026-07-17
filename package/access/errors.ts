export type AccessErrorCode =
  | "configuration"
  | "invalid-identity"
  | "sync-required"
  | "mutation-rejected"
  | "not-found"
  | "invalid-role";

export class AccessError extends Error {
  override readonly name = "AccessError";
  constructor(readonly code: AccessErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function isAccessError(error: unknown): error is AccessError {
  return error instanceof AccessError;
}
