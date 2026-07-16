import {
  authenticateDeviceCredential,
  AuthError,
  classifyCredentialOrigin,
  decryptAtRest,
  deriveAtRestKey,
  derivePrfSecret,
  encryptAtRest,
  enrollDeviceCredential,
} from "./auth.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

// A base64url-decoding rawId ("AQIDBA" is bytes 1,2,3,4) shared by the fakes.
function rawIdBuffer(): ArrayBuffer {
  return new Uint8Array([1, 2, 3, 4]).buffer;
}

// A 37-byte authenticator-data buffer (rpIdHash[32] + flags + signCount[4]).
// The WebAuthn "backup eligible" (BE) flag is bit 0x08 of byte index 32.
function authenticatorData(backupEligible: boolean): ArrayBuffer {
  const bytes = new Uint8Array(37);
  if (backupEligible) bytes[32] |= 0x08;
  return bytes.buffer;
}

// A minimal fake CredentialsContainer whose create/get are supplied per test.
function fakeCredentials(handlers: {
  create?: (options: CredentialCreationOptions) => Promise<Credential | null>;
  get?: (options: CredentialRequestOptions) => Promise<Credential | null>;
}): CredentialsContainer {
  return {
    create: handlers.create ?? (() => Promise.resolve(null)),
    get: handlers.get ?? (() => Promise.resolve(null)),
    store: () => Promise.reject(new Error("unused")),
    preventSilentAccess: () => Promise.resolve(),
  } as unknown as CredentialsContainer;
}

async function expectAuthError(
  operation: () => Promise<unknown>,
  code: AuthError["code"],
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(error instanceof AuthError, "expected an AuthError to be thrown");
    assert(
      error.code === code,
      `expected AuthError code ${code}, received ${(error as AuthError).code}`,
    );
    return;
  }
  throw new Error(`expected AuthError code ${code}, but nothing was thrown`);
}

test("classifyCredentialOrigin treats localhost as local-only", () => {
  const report = classifyCredentialOrigin(new URL("https://localhost"), []);
  assert(report.status === "local-only", "localhost must be local-only");
  assert(report.rpId === "localhost", "the rpId must be the hostname");
});

test("classifyCredentialOrigin blocks insecure, IP, and loopback origins", () => {
  assert(
    classifyCredentialOrigin(new URL("http://example.com"), ["example.com"]).status === "blocked",
    "non-https must be blocked",
  );
  assert(
    classifyCredentialOrigin(new URL("https://93.184.216.34"), []).status === "blocked",
    "a bare IPv4 origin must be blocked",
  );
  assert(
    classifyCredentialOrigin(new URL("https://127.0.0.1"), []).status === "local-only",
    "the loopback address is local-only, never a stable RP-ID",
  );
});

test("classifyCredentialOrigin trusts exact and wildcard hostnames", () => {
  assert(
    classifyCredentialOrigin(new URL("https://app.example.com"), ["*.example.com"]).status ===
      "stable",
    "a host matching a *. pattern must be stable",
  );
  assert(
    classifyCredentialOrigin(new URL("https://example.com"), ["example.com"]).status === "stable",
    "an exact hostname match must be stable",
  );
});

test("classifyCredentialOrigin leaves untrusted secure hosts unverified", () => {
  const report = classifyCredentialOrigin(new URL("https://other.example.org"), ["example.com"]);
  assert(report.status === "unverified", "a secure host not in the list must be unverified");
});

test("enrollDeviceCredential returns a base64url DeviceCredential with an explicit rpId", async () => {
  let createCalls = 0;
  const credentials = fakeCredentials({
    create: () => {
      createCalls += 1;
      return Promise.resolve({ rawId: rawIdBuffer() } as unknown as Credential);
    },
  });
  const credential = await enrollDeviceCredential({ credentials, rpId: "app.example.com" });
  assert(createCalls === 1, "create must be invoked exactly once");
  assert(credential.rpId === "app.example.com", "the credential must carry the supplied rpId");
  // base64url of bytes [1,2,3,4] is "AQIDBA".
  assert(credential.id === "AQIDBA", "the id must be the base64url of the rawId");
});

test("enrollDeviceCredential rejects an unstable origin as origin-rejected", async () => {
  // With no rpId, no trusted origin, and no `location` in Deno, the origin gate
  // reports "blocked", so enrollment must refuse before touching credentials.
  const credentials = fakeCredentials({
    create: () => Promise.reject(new Error("create must not be reached")),
  });
  await expectAuthError(
    () => enrollDeviceCredential({ credentials, trustedOrigins: [] }),
    "origin-rejected",
  );
});

test("authenticateDeviceCredential returns the DeviceCredential from a get result", async () => {
  const credentials = fakeCredentials({
    get: () => Promise.resolve({ rawId: rawIdBuffer() } as unknown as Credential),
  });
  const credential = await authenticateDeviceCredential({ credentials, rpId: "app.example.com" });
  assert(credential.id === "AQIDBA", "the authenticated id must be the base64url rawId");
  assert(credential.rpId === "app.example.com", "the credential must carry the rpId");
});

test("derivePrfSecret returns the PRF result bytes", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const credentials = fakeCredentials({
    get: () =>
      Promise.resolve({
        rawId: rawIdBuffer(),
        getClientExtensionResults: () => ({ prf: { results: { first: secret.buffer } } }),
      } as unknown as Credential),
  });
  const derived = await derivePrfSecret(new Uint8Array([9, 9, 9, 9]), {
    credentials,
    rpId: "app.example.com",
  });
  assert(derived.length === 32, "the derived secret must be 32 bytes");
  assert(
    derived.every((byte, index) => byte === secret[index]),
    "the derived secret must equal the PRF result bytes",
  );
});

test("derivePrfSecret throws prf-unavailable when the client returns no PRF result", async () => {
  const credentials = fakeCredentials({
    get: () =>
      Promise.resolve({
        rawId: rawIdBuffer(),
        getClientExtensionResults: () => ({}),
      } as unknown as Credential),
  });
  await expectAuthError(
    () => derivePrfSecret(new Uint8Array([1]), { credentials, rpId: "app.example.com" }),
    "prf-unavailable",
  );
});

test("at-rest crypto round-trips and binds ciphertext to the info string", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const key = await deriveAtRestKey(secret, "notes");
  const plaintext = new TextEncoder().encode("local-first secret");

  const blob = await encryptAtRest(key, plaintext);
  const roundTripped = await decryptAtRest(key, blob);
  assert(
    new TextDecoder().decode(roundTripped) === "local-first secret",
    "the same key must decrypt its own ciphertext",
  );

  // The same secret + info re-derives a key that also decrypts the prior blob.
  const sameKey = await deriveAtRestKey(secret, "notes");
  const again = await decryptAtRest(sameKey, blob);
  assert(
    new TextDecoder().decode(again) === "local-first secret",
    "the same secret+info must re-derive a working key",
  );

  // A different info yields a different key that cannot decrypt the blob.
  const otherKey = await deriveAtRestKey(secret, "photos");
  let rejected = false;
  try {
    await decryptAtRest(otherKey, blob);
  } catch {
    rejected = true;
  }
  assert(rejected, "a key derived with a different info must fail to decrypt");
});

test("enrollDeviceCredential maps NotAllowedError to cancelled", async () => {
  const credentials = fakeCredentials({
    create: () => Promise.reject({ name: "NotAllowedError" }),
  });
  await expectAuthError(
    () => enrollDeviceCredential({ credentials, rpId: "app.example.com" }),
    "cancelled",
  );
});

test("enrollDeviceCredential maps SecurityError to origin-rejected", async () => {
  const credentials = fakeCredentials({
    create: () => Promise.reject({ name: "SecurityError" }),
  });
  await expectAuthError(
    () => enrollDeviceCredential({ credentials, rpId: "app.example.com" }),
    "origin-rejected",
  );
});

test("enrollDeviceCredential names the passkey with the label and reports portable", async () => {
  let captured: PublicKeyCredentialUserEntity | undefined;
  const credentials = fakeCredentials({
    create: (options) => {
      captured = options.publicKey?.user;
      return Promise.resolve({
        rawId: rawIdBuffer(),
        response: { getAuthenticatorData: () => authenticatorData(true) },
      } as unknown as Credential);
    },
  });
  const credential = await enrollDeviceCredential({
    rpId: "app.example.com",
    label: "work account",
    credentials,
  });
  assert(captured?.name === "work account", "the label must become user.name");
  assert(captured?.displayName === "work account", "the label must become user.displayName");
  assert(credential.portable === true, "a backup-eligible credential must be portable");
});

test("enrollDeviceCredential reports portable false without the BE flag or authenticator data", async () => {
  const clearBit = fakeCredentials({
    create: () =>
      Promise.resolve({
        rawId: rawIdBuffer(),
        response: { getAuthenticatorData: () => authenticatorData(false) },
      } as unknown as Credential),
  });
  const cleared = await enrollDeviceCredential({ rpId: "app.example.com", credentials: clearBit });
  assert(cleared.portable === false, "a device-bound credential must not be portable");

  const noAuthData = fakeCredentials({
    create: () =>
      Promise.resolve({
        rawId: rawIdBuffer(),
        response: {},
      } as unknown as Credential),
  });
  const missing = await enrollDeviceCredential({
    rpId: "app.example.com",
    credentials: noAuthData,
  });
  assert(missing.portable === false, "an unreadable credential must default to not portable");
});
