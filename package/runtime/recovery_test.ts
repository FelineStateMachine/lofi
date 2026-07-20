import {
  // Package contract tests.
  fromRecoveryPhrase,
  RECOVERY_PHRASE_WORDS,
  RecoveryError,
  toRecoveryPhrase,
} from "./recovery.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

// A 32-byte base64url value, the shape of a Jazz account secret.
function sampleSecret(seed = 3): string {
  const bytes = new Uint8Array(32).map((_, i) => (i * 7 + seed) & 0xff);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

test("toRecoveryPhrase encodes an account secret as the expected number of words", () => {
  const phrase = toRecoveryPhrase(sampleSecret());
  assert(
    phrase.split(" ").length === RECOVERY_PHRASE_WORDS,
    `a recovery phrase must be ${RECOVERY_PHRASE_WORDS} words`,
  );
});

test("a phrase round-trips back to the exact same secret", () => {
  const secret = sampleSecret(11);
  const restored = fromRecoveryPhrase(toRecoveryPhrase(secret));
  assert(restored === secret, "the phrase must reconstruct the identical account secret");
});

test("distinct secrets produce distinct phrases", () => {
  assert(
    toRecoveryPhrase(sampleSecret(1)) !== toRecoveryPhrase(sampleSecret(2)),
    "different accounts must not share a recovery phrase",
  );
});

test("fromRecoveryPhrase tolerates messy whitespace and casing", () => {
  const secret = sampleSecret(5);
  const phrase = toRecoveryPhrase(secret);
  const messy = `  ${phrase.toUpperCase().replaceAll(" ", "   ")}\n`;
  assert(fromRecoveryPhrase(messy) === secret, "an honest phrase must survive reformatting");
});

test("fromRecoveryPhrase rejects a wrong word count with invalid-length", () => {
  let code: string | undefined;
  let message = "";
  try {
    fromRecoveryPhrase("one two three");
  } catch (error) {
    if (error instanceof RecoveryError) {
      code = error.code;
      message = error.message;
    }
  }
  assert(code === "invalid-length", "too few words must raise invalid-length");
  assert(
    message.includes(`${RECOVERY_PHRASE_WORDS} words`) && !message.includes("invalid-length"),
    "the invalid-length error must give person-readable word-count guidance",
  );
});

test("fromRecoveryPhrase rejects an empty phrase with invalid-length", () => {
  let threw = false;
  try {
    fromRecoveryPhrase("   ");
  } catch (error) {
    threw = error instanceof RecoveryError && error.code === "invalid-length";
  }
  assert(threw, "an empty phrase must raise a RecoveryError");
});

test("fromRecoveryPhrase rejects a full-length but invalid phrase", () => {
  const words = Array.from({ length: RECOVERY_PHRASE_WORDS }, () => "zzzzzz").join(" ");
  let threw = false;
  try {
    fromRecoveryPhrase(words);
  } catch (error) {
    threw = error instanceof RecoveryError;
  }
  assert(threw, "unknown words or a bad checksum must raise a RecoveryError");
});

test("toRecoveryPhrase rejects a secret that is not a 32-byte base64url value", () => {
  let threw = false;
  try {
    toRecoveryPhrase("too-short");
  } catch (error) {
    threw = error instanceof RecoveryError;
  }
  assert(threw, "an ill-formed secret must raise a RecoveryError, never a fake phrase");
});
