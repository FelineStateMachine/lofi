import {
  backupSecretWithPasskey,
  mapPasskeyBackupError,
  restoreSecretWithPasskey,
} from "./passkey-recovery.ts";
import { assert } from "./test-assert.ts";

function domError(name: string): DOMException {
  return new DOMException("vendor detail must not reach the UI", name);
}

Deno.test("passkey backup errors become actionable non-secret recovery errors", () => {
  const cases = [
    [new PasskeyBackupError("not-supported"), "unsupported"],
    [new PasskeyBackupError("no-credential"), "credential-missing"],
    [new PasskeyBackupError("verification-failed"), "verification-failed"],
    [new PasskeyBackupError("invalid-credential"), "invalid-credential"],
    [new PasskeyBackupError("get-failed", domError("SecurityError")), "rp-id-mismatch"],
    [new PasskeyBackupError("get-failed", domError("NotAllowedError")), "cancelled"],
  ] as const;
  for (const [input, code] of cases) {
    const mapped = mapPasskeyBackupError(input, "restore");
    assert(mapped.code === code, `${input.code} mapped to ${mapped.code}, expected ${code}`);
    assert(
      !mapped.message.includes("vendor detail"),
      "vendor detail leaked into public error text",
    );
  }
});

Deno.test("passkey adapter backs up and restores the exact account secret", async () => {
  const expected = "account-secret";
  let backedUp: { secret: string; displayName: string } | undefined;
  const adapter = {
    backup(secret: string, displayName: string) {
      backedUp = { secret, displayName };
      return Promise.resolve();
    },
    restore() {
      return Promise.resolve(expected);
    },
  };
  await backupSecretWithPasskey(adapter, expected, "Account recovery");
  assert(backedUp?.secret === expected, "backup changed the account secret");
  assert(backedUp?.displayName === "Account recovery", "backup changed the display name");
  assert(
    await restoreSecretWithPasskey(adapter) === expected,
    "restore changed the account secret",
  );
});

Deno.test("unknown passkey failures distinguish backup from restore without leaking causes", () => {
  assert(
    mapPasskeyBackupError(new Error("secret payload"), "backup").code === "backup-failed",
    "unknown backup failure was misclassified",
  );
  assert(
    mapPasskeyBackupError(new Error("secret payload"), "restore").code === "restore-failed",
    "unknown restore failure was misclassified",
  );
});
class PasskeyBackupError extends Error {
  override readonly name = "PasskeyBackupError";
  constructor(readonly code: string, override readonly cause?: unknown) {
    super(code);
  }
}
