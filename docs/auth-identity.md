# The key is the account

lofi's optional identity model: **a passkey _is_ the account.** The Jazz account secret is derived
from the credential, so the account lives wherever the key lives — and moves between devices exactly
as far as the key does.

This is opt-in. The default identity is `device-local` (each device gets its own random account).
Set `identity: "device-passkey"` in `src/app.ts` to switch.

## How it works

Jazz's account secret is a 32-byte value (base64url). The WebAuthn **PRF** extension returns a
32-byte, credential-bound secret that is deterministic for a given `(credential, salt)`. So:

```
account secret = base64url( HKDF-SHA-256( PRF(passkey, fixed-salt) ) )
```

The same credential always derives the same account. No account material is stored on any server; it
is a pure function of the key.

### Boot flow (`device-passkey`)

- **First boot on a device** → passkey ceremony → derive the secret → hand it to Jazz → cache it
  locally (`BrowserAuthSecretStore.saveSecret`).
- **Return boots** → the cached secret is used; no ceremony. "Identity never waits" still holds for
  the common path.
- **A new device** → the same portable key → the same PRF → the same secret → the same Jazz account
  → your data syncs down and decrypts. Jazz already E2E-encrypts synced data keyed on the account,
  so nothing extra is needed for confidentiality.

## Portable vs device-bound — and telling the user which they chose

A passkey binds to its origin (RP ID) and roams (or doesn't) based on the credential provider, not
the OS. `enrollDeviceCredential` reports this via the WebAuthn **backup-eligible (BE)** flag:

- **Portable** (`portable: true`) — a password-manager or platform-synced passkey (1Password,
  iCloud, Google) or a hardware key you carry. **The account travels with it.** Favor these.
- **Device-bound** (`portable: false`) — Touch ID / Windows Hello without sync. **The account only
  exists on this device.** Allowed, but the app should say so: _use a portable passkey to reach this
  account elsewhere._

The nickname passed as `label` becomes the passkey's name in the user's password manager, so they
can see which account a key unlocks.

## Custody and recovery — stated plainly

- **No recovery service.** lofi never holds recoverable account material. Recovery is delegated to
  _where the key lives_: your password manager's own sync, or a second enrolled hardware key.
- **Lose every copy of the key → lose the account.** That is the honest cost of no-central-custody,
  and it is the same custody the device-local identity already has.
- **This is not the rejected passkey-_backup_ ceremony.** The Jazz alpha's server-assisted passkey
  account backup was rejected on security grounds. This model has no server-side account backup at
  all — the account is derived locally from the key — so it sidesteps that entirely.

## Guardrails (honest by construction)

- **Feature-detected.** `getAuthCapability()` reports `webAuthn` + `prf`; if PRF is unavailable,
  derivation throws `prf-unavailable` rather than fabricating a secret.
- **Origin-gated.** Enrollment and derivation refuse unless the origin is `stable` (an
  author-committed hostname in `credentialOrigins`), because a passkey silently breaks if its origin
  changes.

## Enabling it

```ts
// src/app.ts
identity: "device-passkey",
credentialOrigins: ["app.example.com"], // your committed-stable hostname(s)
```

```ts
import { deriveAuthSecret, enrollDeviceCredential, getAuthCapability } from "./_lofi/auth.ts";

const { prf, origin } = await getAuthCapability();
if (prf === "available" && origin.status === "stable") {
  const cred = await enrollDeviceCredential({ label: "work account" });
  // cred.portable === true  → the account will travel with this key
  const secret = await deriveAuthSecret(); // the Jazz account secret
}
```

The runtime does this wiring for you when `identity: "device-passkey"`.
