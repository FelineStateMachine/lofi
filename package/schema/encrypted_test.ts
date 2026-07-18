// Encrypted-column contract: seal/open round-trip, fail-closed without a key,
// label domain separation, tamper and wrong-key refusal, and the stored shape
// (versioned prefix, no plaintext in any trivial encoding).
import {
  clearEncryptedColumnKey,
  EncryptedColumnError,
  encryptedJson,
  encryptedText,
  setEncryptedColumnKey,
} from "./encrypted.ts";
import { assert } from "../runtime/test-assert.ts";

type Transformed = {
  _columnTransforms?: never;
} & { transform?: never };

// The facade casts transformed columns back to typed builders; tests reach the
// live transform pair through the runtime column object the same way the
// engine does.
function transformOf(column: unknown): {
  to: (value: unknown) => string;
  from: (value: string) => unknown;
} {
  const transform = (column as { _transform?: unknown })._transform ??
    (column as { transform?: unknown }).transform;
  assert(
    typeof transform === "object" && transform !== null,
    `column carries no transform pair: ${JSON.stringify(Object.keys(column as object))}`,
  );
  return transform as { to: (value: unknown) => string; from: (value: string) => unknown };
}

const key = new Uint8Array(32).map((_, index) => index + 1);
const otherKey = new Uint8Array(32).map((_, index) => 101 + index);

function withKey(body: () => void): () => void {
  return () => {
    setEncryptedColumnKey(key);
    try {
      body();
    } finally {
      clearEncryptedColumnKey();
    }
  };
}

function expectFailure(
  run: () => unknown,
  code: EncryptedColumnError["code"],
  context: string,
): void {
  try {
    run();
  } catch (error) {
    assert(
      error instanceof EncryptedColumnError && error.code === code,
      `${context}: expected ${code}, received ${String(error)}`,
    );
    return;
  }
  throw new Error(`${context}: expected ${code}, but the operation succeeded`);
}

Deno.test(
  "text and json values round-trip and store versioned ciphertext",
  withKey(() => {
    const text = transformOf(encryptedText("t.body"));
    const plaintext = "a private sentence nobody else reads";
    const stored = text.to(plaintext);
    assert(
      stored.startsWith("enc1."),
      `stored value lacks the version prefix: ${stored.slice(0, 12)}`,
    );
    assert(!stored.includes(plaintext), "stored value contains the plaintext");
    assert(!stored.includes(btoa(plaintext)), "stored value contains base64 plaintext");
    assert(text.from(stored) === plaintext, "text round-trip mismatch");
    assert(text.to(plaintext) !== stored, "sealing must be randomized per write");

    const json = transformOf(encryptedJson<{ n: number }>("t.meta"));
    const value = { n: 42 };
    const storedJson = json.to(value);
    assert(!storedJson.includes("42"), "stored json contains plaintext content");
    assert(
      (json.from(storedJson) as { n: number }).n === 42,
      "json round-trip mismatch",
    );
  }),
);

Deno.test("without an installed key every operation fails closed", () => {
  clearEncryptedColumnKey();
  const text = transformOf(encryptedText("t.body"));
  expectFailure(() => text.to("value"), "key-missing", "seal without key");
  // A structurally well-formed value: 40 base64url chars decode to 30 bytes,
  // past the nonce-length check, so the missing key is what refuses.
  expectFailure(() => text.from(`enc1.${"A".repeat(40)}`), "key-missing", "open without key");
  expectFailure(
    () => setEncryptedColumnKey(new Uint8Array(16)),
    "key-invalid",
    "short key",
  );
});

Deno.test(
  "labels domain-separate: ciphertext cannot replay across columns",
  withKey(() => {
    const first = transformOf(encryptedText("a.body"));
    const second = transformOf(encryptedText("b.body"));
    const stored = first.to("value");
    expectFailure(() => second.from(stored), "corrupt", "cross-column replay");
  }),
);

Deno.test(
  "tampered, truncated, unprefixed, and foreign-key values are refused",
  withKey(() => {
    const text = transformOf(encryptedText("t.body"));
    const stored = text.to("value");
    const flipped = stored.slice(0, -2) + (stored.endsWith("aa") ? "bb" : "aa");
    expectFailure(() => text.from(flipped), "corrupt", "tampered value");
    expectFailure(() => text.from("enc1.AAAA"), "corrupt", "truncated value");
    expectFailure(() => text.from("plaintext"), "corrupt", "unprefixed value");
    setEncryptedColumnKey(otherKey);
    expectFailure(() => text.from(stored), "corrupt", "foreign key");
  }),
);
