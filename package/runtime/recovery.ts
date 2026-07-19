/**
 * Recovery-phrase backup for the local-first account.
 *
 * A lofi account is a 32-byte secret held on the device. That is enough to work
 * offline forever, but it means a cleared browser or a second device has no way
 * back in. A recovery phrase is the honest, portable backup: the *same* secret,
 * encoded as 24 English words the user can write down. Typing them back on any
 * device reconstructs the identical account — so the data that synced up comes
 * straight back down, decrypted, under the same identity.
 *
 * This is a thin, feature-detected wrapper over Jazz's `RecoveryPhrase`
 * (`jazz-tools/passphrase`). It makes no server or escrow claim: the phrase is
 * the account, so whoever holds it holds the account, and losing every copy of
 * both the device and the phrase loses it for good.
 *
 * @module
 */

import { RecoveryPhrase, RecoveryPhraseError } from "jazz-tools/passphrase";

/** The number of words in a lofi recovery phrase. */
export const RECOVERY_PHRASE_WORDS = 24;

/** A precise, non-leaking failure reason for a recovery-phrase operation. */
export class RecoveryError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "RecoveryError";
  /** Actionable category that callers can map to recovery guidance. */
  readonly code: "invalid-length" | "invalid-word" | "invalid-checksum" | "invalid-secret";
  /** Creates a phrase error without retaining the submitted phrase. */
  constructor(code: RecoveryError["code"], message?: string) {
    super(message ?? `Recovery phrase operation failed: ${code}.`);
    this.code = code;
  }
}

const MESSAGES: Record<RecoveryError["code"], string> = {
  "invalid-length":
    `A recovery phrase is ${RECOVERY_PHRASE_WORDS} words — check for a missing or extra word.`,
  "invalid-word": "One of the words is not in the recovery word list — check your spelling.",
  "invalid-checksum":
    "That phrase is not a valid recovery phrase — re-check the words and their order.",
  "invalid-secret": "The account secret could not be encoded as a recovery phrase.",
};

function mapError(error: unknown): RecoveryError {
  if (error instanceof RecoveryError) return error;
  if (error instanceof RecoveryPhraseError) {
    const code = error.code as RecoveryError["code"];
    return new RecoveryError(code, MESSAGES[code] ?? undefined);
  }
  return new RecoveryError("invalid-checksum", error instanceof Error ? error.message : undefined);
}

/**
 * Encodes an account secret as its {@link RECOVERY_PHRASE_WORDS}-word recovery
 * phrase. The phrase *is* the secret — show it once for the user to write down,
 * never persist it.
 */
export function toRecoveryPhrase(secret: string): string {
  try {
    return RecoveryPhrase.fromSecret(secret);
  } catch (error) {
    throw mapError(error);
  }
}

// Collapses the many ways a person types a phrase (extra spaces, stray casing,
// smart punctuation) down to the canonical space-separated lowercase words the
// decoder expects, so an honest phrase is not rejected over formatting.
function normalizePhrase(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[^A-Za-z\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Decodes a user-entered recovery phrase back into the account secret,
 * tolerating whitespace and casing differences. Throws {@link RecoveryError}
 * with an actionable code — never a fabricated secret — when the phrase is
 * malformed.
 */
export function fromRecoveryPhrase(phrase: string): string {
  const normalized = normalizePhrase(phrase);
  if (normalized.length === 0) throw new RecoveryError("invalid-length");
  if (normalized.split(" ").length !== RECOVERY_PHRASE_WORDS) {
    throw new RecoveryError("invalid-length");
  }
  try {
    return RecoveryPhrase.toSecret(normalized);
  } catch (error) {
    throw mapError(error);
  }
}
