# lofi device auth

Status: **primitive validated in reference source; `./auth` subpath deferred to a later milestone**\
Scope: **device-local WebAuthn + PRF at-rest key derivation**

> **Advanced runtime seam.** Generated applications consume this through the supported root package
> export, and normal product work should not reimplement it. Use this document only when
> deliberately evaluating the optional device-credential primitive. Account sync and recovery are
> documented separately in [Sync and recovery](sync-and-recovery.md).

lofi device auth is a small, honest **primitive**, not a mandated identity or recovery scheme.
Local-first identity is device-local and cryptographic — there is no central store to authenticate
against — so this module does exactly three things: enroll a device passkey, authenticate with it,
and derive a credential-bound key to encrypt data **at rest**. The generated session runtime handles
accounts, recoverable-passkey backup, recovery phrases, and optional multi-device sync separately.

The runtime lives at `package/runtime/auth.ts` and is exposed through `@nzip/lofi`.

## What it guarantees

- **Enrollment is gated on a stable origin.** A passkey binds to its origin hostname (its RP-ID); if
  that origin later changes, the credential silently breaks. `classifyCredentialOrigin` reports the
  current origin as `stable`, `local-only`, `unverified`, or `blocked`, and enrollment refuses
  anything but `stable` or `local-only`. Authors declare their committed hostnames in `src/app.ts`
  `credentialOrigins` (exact, or a `*.` suffix pattern); a deployed host that is not listed is
  `unverified` and refused — there is no implicit trust of the served hostname, so a preview origin
  cannot mint credentials that strand on the production one. `localhost` and `127.0.0.1` are
  `local-only` — useful for development, never a shipping RP-ID.
- **The phrase-guard ceremony is pinned to its enrolled credential.** Authentication passes
  `allowCredentials` for the enrolled credential id and verifies the asserting credential against
  it, failing with `credential-mismatch` otherwise — another resident passkey for the same RP-ID
  cannot satisfy the guard. Guards enrolled before pinning remain discoverable until re-enrolled.
- **PRF derives an at-rest key, and is never faked.** The WebAuthn PRF extension yields a 32-byte
  secret bound to the credential, from which `deriveAtRestKey` produces an AES-GCM key via
  HKDF-SHA-256. PRF support is feature-detected (`getAuthCapability`); if the client or
  authenticator does not return a PRF result, the derive path throws `prf-unavailable` rather than
  inventing a key.
- **No recovery claim for this primitive.** `enrollDeviceCredential` and the PRF-derived key do not
  contain the Jazz account secret, so they cannot restore an account. Account recovery uses the
  separate `createRecoverablePasskeyBackup` / `restoreFromPasskey` flow documented in
  [Sync and recovery](sync-and-recovery.md), with an RP-ID- and provider-independent phrase
  fallback.

## Usage

```ts
import {
  deriveAtRestKey,
  derivePrfSecret,
  encryptAtRest,
  enrollDeviceCredential,
  getAuthCapability,
} from "@nzip/lofi";

// 1. Feature-detect before offering enrollment.
const capability = await getAuthCapability();
if (!capability.webAuthn || capability.origin.status !== "stable") {
  throw new Error(capability.origin.action);
}

// 2. Enroll a resident, user-verifying device passkey (once per device).
const credential = await enrollDeviceCredential();

// 3. Derive a credential-bound PRF secret from a stable, app-owned salt.
const salt = new TextEncoder().encode("notes.v1");
const prfSecret = await derivePrfSecret(salt);

// 4. Turn the secret into an at-rest key and encrypt. Vary `info` to bind
//    unrelated data to different keys.
const key = await deriveAtRestKey(prfSecret, "notes");
const blob = await encryptAtRest(key, new TextEncoder().encode("local-first secret"));

console.log(credential.id, blob.iv.length, blob.ciphertext.length);
```

## Testing

- **Unit** (`package/runtime/auth_test.ts`): origin classification, enroll/authenticate, PRF result
  handling, error mapping, and the HKDF -> AES-GCM round-trip run without a browser by injecting a
  fake `CredentialsContainer` and an explicit `rpId`.
- **Browser** (`tests/auth_e2e_test.ts` + `@nzip/lofi/testing`'s `withVirtualAuthenticator`): a CDP
  virtual authenticator drives an enroll -> authenticate round-trip headless. CDP virtual
  authenticators do **not** reliably model the PRF extension, so PRF derivation is not exercised
  there; it is feature-detected and validated on real devices.
