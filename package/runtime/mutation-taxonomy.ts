/**
 * Package-owned mutation-error taxonomy.
 *
 * The sync node adjudicates a write that was accepted locally and emits a
 * rejection code. This module maps those codes onto the one distinction the
 * effect system acts on: permanent verdicts compensate, everything else stays
 * pending. The classification mirrors the taxonomy the lofi sync node
 * publishes; codes this package does not recognize are `unknown` and are
 * never treated as permanent, so an uninterpretable code can never trigger
 * compensation.
 *
 * @module
 */

/**
 * How a rejection code is acted on: `permanent` verdicts settle the write as
 * `rejected` and run compensation, `transient` and `unknown` codes leave the
 * write pending until a later settlement attempt resolves it.
 */
export type MutationErrorClass = "permanent" | "transient" | "unknown";

// The one permanent code the node emits today. Growing this set is a
// package-version decision made together with the node's taxonomy.
const permanentCodes = new Set(["permission_denied"]);

// Codes describing delivery conditions rather than verdicts.
const transientCodes = new Set(["network", "timeout", "disconnected"]);

/**
 * Classifies a sync-node rejection code. `permission_denied` is `permanent`;
 * known delivery-condition codes are `transient`; anything else — including a
 * missing code — is `unknown`. Compensation gates on `permanent` only.
 */
export function classifyMutationError(code: string | null | undefined): MutationErrorClass {
  if (!code) return "unknown";
  if (permanentCodes.has(code)) return "permanent";
  if (transientCodes.has(code)) return "transient";
  return "unknown";
}
