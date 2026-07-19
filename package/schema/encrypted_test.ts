// Encrypted-column contract: seal/open round-trip, fail-closed without a key,
// label domain separation, tamper and wrong-key refusal, and the stored shape
// (versioned prefix, no plaintext in any trivial encoding).
import {
  clearEncryptedColumnKey,
  clearEncryptedColumnRegistry,
  EncryptedColumnError,
  encryptedColumnsOf,
  encryptedDate,
  encryptedJson,
  encryptedNumber,
  encryptedText,
  isEncryptedColumn,
  matchDecrypted,
  registerEncryptedColumns,
  setEncryptedColumnKey,
} from "./encrypted.ts";
import { paddedLength, padPayload, unpadPayload } from "./padding.ts";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";
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
      stored.startsWith("enc2."),
      `stored value lacks the version prefix: ${stored.slice(0, 12)}`,
    );
    assert(!stored.includes(plaintext), "stored value contains the plaintext");
    assert(!stored.includes(btoa(plaintext)), "stored value contains base64 plaintext");
    assert(text.from(stored) === plaintext, "text round-trip mismatch");
    assert(text.to(plaintext) !== stored, "sealing must be randomized per write");

    const json = transformOf(encryptedJson<{ note: string }>("t.meta"));
    // A long distinctive marker: short digit runs occur by chance in
    // base64url ciphertext, so the no-plaintext probe needs entropy.
    const value = { note: "distinctive-plaintext-marker" };
    const storedJson = json.to(value);
    assert(
      !storedJson.includes("distinctive-plaintext-marker"),
      "stored json contains plaintext content",
    );
    assert(
      (json.from(storedJson) as { note: string }).note === value.note,
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
    expectFailure(() => text.from("enc1.AAAA"), "corrupt", "truncated legacy value");
    expectFailure(() => text.from("enc2.AAAA"), "corrupt", "truncated value");
    expectFailure(() => text.from("plaintext"), "corrupt", "unprefixed value");
    setEncryptedColumnKey(otherKey);
    expectFailure(() => text.from(stored), "corrupt", "foreign key");
  }),
);

Deno.test("padding buckets are floored, self-describing, and reversible", () => {
  assert(paddedLength(1) === 64, "tiny payloads pad to the floor");
  assert(paddedLength(64) === 64, "the floor is inclusive");
  assert(paddedLength(65) > 64, "past the floor the bucket grows");
  for (const size of [0, 1, 60, 61, 500, 70_000]) {
    const payload = new Uint8Array(size).map((_, index) => index % 251);
    const padded = padPayload(payload);
    assert(padded.length === paddedLength(4 + size), `bucket mismatch at ${size}`);
    const recovered = unpadPayload(padded);
    assert(
      recovered.length === size && recovered.every((byte, index) => byte === payload[index]),
      `padding round-trip mismatch at ${size}`,
    );
  }
  const declaresPastEnd = new Uint8Array(64);
  new DataView(declaresPastEnd.buffer).setUint32(0, 61);
  let threw = false;
  try {
    unpadPayload(declaresPastEnd);
  } catch {
    threw = true;
  }
  assert(threw, "a length declared past the buffer must refuse");
});

Deno.test(
  "stored lengths reveal the size class, not the payload length",
  withKey(() => {
    const text = transformOf(encryptedText("t.body"));
    const short = text.to("a");
    const longer = text.to("a".repeat(40));
    assert(
      short.length === longer.length,
      `payloads in one bucket must store identically: ${short.length} vs ${longer.length}`,
    );
    const pastFloor = text.to("a".repeat(200));
    assert(pastFloor.length > short.length, "a larger bucket must store longer");
  }),
);

// A legacy value sealed exactly as the pre-padding format wrote it: subkey
// from the same HKDF chain, the unversioned associated data, no padding.
function sealLegacy(label: string, plaintext: string): string {
  const subkey = hkdf(sha256, key, undefined, `lofi:encrypted-column:${label}`, 32);
  const nonce = new Uint8Array(24).map((_, index) => 255 - index);
  const cipher = xchacha20poly1305(
    subkey,
    nonce,
    new TextEncoder().encode(`lofi:encrypted-column:${label}`),
  );
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext));
  const bytes = new Uint8Array(24 + ciphertext.length);
  bytes.set(nonce);
  bytes.set(ciphertext, 24);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return "enc1." + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

Deno.test(
  "legacy enc1 values still open; prefix flips refuse in both directions",
  withKey(() => {
    const text = transformOf(encryptedText("t.body"));
    const legacy = sealLegacy("t.body", "written before padding existed");
    assert(
      text.from(legacy) === "written before padding existed",
      "legacy value failed to open",
    );
    expectFailure(
      () => text.from("enc2." + legacy.slice("enc1.".length)),
      "corrupt",
      "legacy value replayed under the padded prefix",
    );
    const padded = text.to("value");
    expectFailure(
      () => text.from("enc1." + padded.slice("enc2.".length)),
      "corrupt",
      "padded value replayed under the legacy prefix",
    );
  }),
);

Deno.test(
  "number and date values round-trip; invalid inputs refuse at the boundary",
  withKey(() => {
    const amount = transformOf(encryptedNumber("t.amount"));
    for (const value of [0, -1.5, 2 ** 40 + 0.5, Number.MAX_SAFE_INTEGER]) {
      const stored = amount.to(value);
      assert(amount.from(stored) === value, `number round-trip mismatch at ${value}`);
    }
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY]) {
      let threw = false;
      try {
        amount.to(invalid);
      } catch (error) {
        threw = error instanceof TypeError;
      }
      assert(threw, `non-finite number ${invalid} must refuse with TypeError`);
    }
    expectFailure(
      () => amount.from(transformOf(encryptedText("t.amount")).to("not a number")),
      "corrupt",
      "non-numeric payload",
    );

    const at = transformOf(encryptedDate("t.at"));
    const moment = new Date("2026-07-19T12:34:56.789Z");
    const storedDate = at.to(moment);
    assert(
      (at.from(storedDate) as Date).getTime() === moment.getTime(),
      "date round-trip mismatch",
    );
    let rejectedInvalidDate = false;
    try {
      at.to(new Date(Number.NaN));
    } catch (error) {
      rejectedInvalidDate = error instanceof TypeError;
    }
    assert(rejectedInvalidDate, "an invalid date must refuse with TypeError");
  }),
);

Deno.test("the registry records encrypted columns per table and clears", () => {
  clearEncryptedColumnRegistry();
  try {
    registerEncryptedColumns({
      journal: {
        title: { _sqlType: "TEXT" },
        body: encryptedText("journal.body"),
        mood: encryptedNumber("journal.mood"),
      },
    });
    assert(isEncryptedColumn("journal", "body"), "body must register as encrypted");
    assert(isEncryptedColumn("journal", "mood"), "mood must register as encrypted");
    assert(!isEncryptedColumn("journal", "title"), "plaintext column must not register");
    assert(!isEncryptedColumn("elsewhere", "body"), "other tables must not register");
    const registered = encryptedColumnsOf("journal");
    assert(
      registered?.get("body") === "journal.body" && registered?.get("mood") === "journal.mood",
      "labels must be retrievable per column",
    );
    clearEncryptedColumnRegistry();
    assert(!isEncryptedColumn("journal", "body"), "clear must empty the registry");
  } finally {
    clearEncryptedColumnRegistry();
  }
});

Deno.test("matchDecrypted filters rows on decrypted values", () => {
  const rows = [
    { id: "a", body: "meeting notes" },
    { id: "b", body: "grocery list" },
  ];
  const matched = matchDecrypted(rows, (row) => row.body.includes("notes"));
  assert(matched.length === 1 && matched[0].id === "a", "predicate must select by content");
});
