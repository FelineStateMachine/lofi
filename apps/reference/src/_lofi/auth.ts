/**
 * Device credential auth for local-first apps.
 *
 * Local-first identity is device-local and cryptographic — there is no central
 * store to authenticate against. This module is lofi's small, honest WebAuthn +
 * PRF primitive: enroll a device passkey, authenticate with it, and derive a
 * credential-bound key (PRF) to encrypt data **at rest**.
 *
 * It is feature-detected and never faked: if the device cannot do WebAuthn or
 * PRF, {@link getAuthCapability} says so and the derive path throws rather than
 * inventing a key. It makes **no** recovery claim — a lost device means lost
 * access, the same custody the device-local identity already has.
 *
 * @module
 */

import { referenceApp } from "../app.ts";

/** Whether the WebAuthn PRF extension can be used on this client. */
export type PrfSupport = "available" | "not-reported" | "unknown" | "unavailable";

/**
 * How stable the current origin is for enrolling a passkey. A passkey is bound
 * to the origin hostname (its RP ID); enrolling on an origin that later changes
 * silently breaks the credential, so enrollment is gated on `stable`.
 */
export type CredentialOriginReport = {
  status: "stable" | "local-only" | "unverified" | "blocked";
  /** The relying-party id (origin hostname) a credential would bind to. */
  rpId: string;
  /** Human-readable next step for the current status. */
  action: string;
};

/** What the current device/browser/origin can do for credential auth. */
export type AuthCapability = {
  webAuthn: boolean;
  prf: PrfSupport;
  origin: CredentialOriginReport;
};

/** An enrolled or authenticated device credential. */
export type DeviceCredential = {
  /** The opaque, base64url-encoded credential id. Safe to persist and compare. */
  id: string;
  /** The relying-party id the credential is bound to. */
  rpId: string;
  /**
   * Whether the credential is backup-eligible — i.e. it syncs/roams across the
   * user's devices (a password-manager or platform-synced passkey) rather than
   * being bound to this one device. With "the key is the account", a portable
   * credential means the account travels with it; a device-bound one does not.
   */
  portable: boolean;
};

/** Injected browser surfaces, so the flows are unit-testable without a device. */
export type AuthDependencies = {
  credentials?: CredentialsContainer;
  rpId?: string;
  trustedOrigins?: readonly string[];
};

/** Options for {@link enrollDeviceCredential}. */
export type EnrollOptions = AuthDependencies & {
  /**
   * A human-readable nickname for the credential. It becomes the passkey's
   * name/displayName, so the user can identify which account it belongs to in
   * their password manager or OS passkey list. Defaults to the app name.
   */
  label?: string;
};

/** A precise, non-leaking failure reason for a credential operation. */
export class AuthError extends Error {
  override readonly name = "AuthError";
  readonly code:
    | "cancelled"
    | "origin-rejected"
    | "unsupported"
    | "prf-unavailable"
    | "credential-missing"
    | "unknown";

  constructor(code: AuthError["code"], message?: string) {
    super(message ?? `Device credential operation failed: ${code}.`);
    this.code = code;
  }
}

// WebAuthn PRF extension types are not in the DOM lib yet; declare the minimum.
type PrfInputs = { eval?: { first: BufferSource; second?: BufferSource } };
type PrfResults = { results?: { first?: ArrayBuffer; second?: ArrayBuffer } };
type CreateExtensions = PublicKeyCredentialCreationOptions["extensions"] & {
  prf?: Record<never, never>;
};
type RequestExtensions = PublicKeyCredentialRequestOptions["extensions"] & { prf?: PrfInputs };
type ClientCapabilities = typeof PublicKeyCredential & {
  getClientCapabilities?: () => Promise<Record<string, boolean>>;
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomBytes(length = 32): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function browserCredentials(): CredentialsContainer {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new AuthError("unsupported");
  }
  return navigator.credentials;
}

function rawId(credential: Credential | null): Uint8Array {
  if (!credential || !("rawId" in credential) || !(credential.rawId instanceof ArrayBuffer)) {
    throw new AuthError("credential-missing");
  }
  return new Uint8Array(credential.rawId);
}

// Reads the WebAuthn "backup eligible" (BE) flag from the authenticator data of
// a create() attestation or a get() assertion. BE=1 means the credential can
// roam/sync across the user's devices. Best-effort: false when unreadable.
function isPortable(credential: Credential | null): boolean {
  const response = (credential as
    | Credential & {
      response?: { getAuthenticatorData?: () => ArrayBuffer; authenticatorData?: ArrayBuffer };
    }
    | null)?.response;
  const authData = response?.getAuthenticatorData?.() ?? response?.authenticatorData;
  if (!authData) return false;
  const bytes = new Uint8Array(authData);
  return bytes.length >= 33 && (bytes[32] & 0x08) !== 0;
}

function mapError(error: unknown): AuthError {
  if (error instanceof AuthError) return error;
  const name = typeof error === "object" && error !== null && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  if (name === "NotAllowedError") return new AuthError("cancelled");
  if (name === "SecurityError") return new AuthError("origin-rejected");
  if (name === "NotSupportedError") return new AuthError("unsupported");
  return new AuthError("unknown", error instanceof Error ? error.message : undefined);
}

// --- Origin / RP-ID stability -------------------------------------------------

function canonicalHostname(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1";
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function matchesTrustedOrigin(hostname: string, pattern: string): boolean {
  const normalized = canonicalHostname(pattern.toLowerCase());
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1);
    return hostname.length > suffix.length && hostname.endsWith(suffix);
  }
  return normalized.length > 0 && !normalized.includes("*") && hostname === normalized;
}

/**
 * Classifies whether `url` is a safe origin to enroll a device credential on,
 * against the author's committed-stable hostnames (`app.ts` `credentialOrigins`,
 * exact hostnames or `*.` suffix patterns). Guidance is platform-agnostic — the
 * requirement is a stable HTTPS origin you control, however you serve it.
 */
export function classifyCredentialOrigin(
  url: URL,
  trustedOrigins: readonly string[] = referenceApp.credentialOrigins ?? [],
): CredentialOriginReport {
  const rpId = url.hostname;
  const hostname = canonicalHostname(rpId);
  if (isLocalHostname(hostname)) {
    return {
      status: "local-only",
      rpId,
      action:
        "localhost credentials do not transfer; enroll on the stable HTTPS origin you will ship on",
    };
  }
  if (url.protocol !== "https:" || !hostname || isIpAddress(hostname)) {
    return {
      status: "blocked",
      rpId,
      action: "serve over a stable HTTPS origin before enrolling a device credential",
    };
  }
  if (trustedOrigins.some((pattern) => matchesTrustedOrigin(hostname, pattern))) {
    return {
      status: "stable",
      rpId,
      action: "keep this hostname for the lifetime of any device credential",
    };
  }
  return {
    status: "unverified",
    rpId,
    action:
      "add this hostname to credentialOrigins once you have committed to keeping it permanent",
  };
}

function currentOrigin(trustedOrigins?: readonly string[]): CredentialOriginReport {
  if (typeof location === "undefined") {
    return { status: "blocked", rpId: "", action: "open the application in a browser" };
  }
  const url = new URL(location.href);
  const declared = trustedOrigins ?? referenceApp.credentialOrigins ?? [];
  // Default trust is the origin you are actually served from: the passkey binds
  // to this hostname (its RP ID) regardless, so trusting it lets the app work
  // wherever it is deployed. Pin explicit hosts in `app.ts` `credentialOrigins`
  // to keep enrollment working across a host change — a passkey silently breaks
  // if its origin moves.
  const trusted = declared.length > 0 ? declared : [url.hostname];
  return classifyCredentialOrigin(url, trusted);
}

function requireStableRpId(dependencies: AuthDependencies): string {
  if (dependencies.rpId) return dependencies.rpId;
  const origin = currentOrigin(dependencies.trustedOrigins);
  // Enroll where you are actually served: a committed HTTPS host (`stable`) or
  // loopback during local development (`local-only`). Refuse insecure origins
  // and hosts that an explicit `credentialOrigins` allowlist excludes.
  if (origin.status !== "stable" && origin.status !== "local-only") {
    throw new AuthError("origin-rejected", origin.action);
  }
  return origin.rpId;
}

// --- Capability ---------------------------------------------------------------

async function readPrfSupport(webAuthn: boolean): Promise<PrfSupport> {
  if (!webAuthn) return "unavailable";
  const publicKeyCredential = PublicKeyCredential as ClientCapabilities;
  if (typeof publicKeyCredential.getClientCapabilities !== "function") return "unknown";
  try {
    const capabilities = await publicKeyCredential.getClientCapabilities();
    return capabilities["extension:prf"] === true ? "available" : "not-reported";
  } catch {
    return "unknown";
  }
}

/** Reports what the current device/browser/origin can do for credential auth. */
export async function getAuthCapability(
  dependencies: AuthDependencies = {},
): Promise<AuthCapability> {
  const webAuthn = typeof PublicKeyCredential === "function";
  return {
    webAuthn,
    prf: await readPrfSupport(webAuthn),
    origin: currentOrigin(dependencies.trustedOrigins),
  };
}

// --- Enroll / authenticate ----------------------------------------------------

/**
 * Enrolls a resident, user-verifying device passkey with the PRF extension
 * enabled. Refuses unless the current origin is `stable` (pass `rpId` to test).
 * The returned `portable` flag says whether the credential roams across devices;
 * `label` names it in the user's password manager. Returns the opaque id.
 */
export async function enrollDeviceCredential(
  options: EnrollOptions = {},
): Promise<DeviceCredential> {
  const rpId = requireStableRpId(options);
  const credentials = options.credentials ?? browserCredentials();
  const label = options.label ?? referenceApp.name;
  try {
    const credential = await credentials.create({
      publicKey: {
        rp: { id: rpId, name: referenceApp.name },
        user: { id: randomBytes(), name: label, displayName: label },
        challenge: randomBytes(),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        attestation: "none",
        timeout: 60_000,
        extensions: { prf: {} } as CreateExtensions,
      },
    });
    return { id: toBase64Url(rawId(credential)), rpId, portable: isPortable(credential) };
  } catch (error) {
    throw mapError(error);
  }
}

/** Authenticates with a device passkey (discoverable get, user-verifying). */
export async function authenticateDeviceCredential(
  dependencies: AuthDependencies = {},
): Promise<DeviceCredential> {
  const rpId = requireStableRpId(dependencies);
  const credentials = dependencies.credentials ?? browserCredentials();
  try {
    const credential = await credentials.get({
      publicKey: { rpId, challenge: randomBytes(), userVerification: "required", timeout: 60_000 },
    });
    return { id: toBase64Url(rawId(credential)), rpId, portable: isPortable(credential) };
  } catch (error) {
    throw mapError(error);
  }
}

// --- PRF-derived at-rest key --------------------------------------------------

// Runs a single user-verifying `get()` with the PRF extension and returns both
// the PRF secret and the asserting credential's identity, so a caller can derive
// the account and report which key unlocked it from one ceremony (one prompt).
async function prfAssertion(
  salt: BufferSource,
  dependencies: AuthDependencies,
): Promise<{ prfSecret: Uint8Array; credential: DeviceCredential }> {
  const rpId = requireStableRpId(dependencies);
  const credentials = dependencies.credentials ?? browserCredentials();
  try {
    const credential = await credentials.get({
      publicKey: {
        rpId,
        challenge: randomBytes(),
        userVerification: "required",
        timeout: 60_000,
        extensions: { prf: { eval: { first: salt } } } as RequestExtensions,
      },
    });
    const results =
      (credential as (Credential & { getClientExtensionResults?: () => { prf?: PrfResults } }))
        .getClientExtensionResults?.().prf?.results;
    if (!results?.first) throw new AuthError("prf-unavailable");
    return {
      prfSecret: new Uint8Array(results.first),
      credential: { id: toBase64Url(rawId(credential)), rpId, portable: isPortable(credential) },
    };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Derives a credential-bound secret from the passkey via the WebAuthn PRF
 * extension. The same `salt` on the same authenticator yields the same 32-byte
 * secret; it never leaves the device. Throws `prf-unavailable` if the client or
 * authenticator does not return a PRF result — the secret is never faked.
 */
export async function derivePrfSecret(
  salt: BufferSource,
  dependencies: AuthDependencies = {},
): Promise<Uint8Array> {
  return (await prfAssertion(salt, dependencies)).prfSecret;
}

/**
 * Turns a PRF secret into an AES-GCM key for at-rest encryption via HKDF-SHA-256.
 * Bind unrelated data to different keys by varying `info`.
 */
export async function deriveAtRestKey(
  prfSecret: Uint8Array,
  info: string,
  salt: Uint8Array = new Uint8Array(0),
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    prfSecret as BufferSource,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: new TextEncoder().encode(info),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts `plaintext` with an at-rest key, returning a self-contained blob. */
export async function encryptAtRest(
  key: CryptoKey,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext as BufferSource,
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/** Decrypts a blob produced by {@link encryptAtRest}. */
export async function decryptAtRest(
  key: CryptoKey,
  blob: { iv: Uint8Array; ciphertext: Uint8Array },
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.iv as BufferSource },
    key,
    blob.ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}

// --- Account identity ("the key is the account") -----------------------------

// A fixed salt so the same credential always derives the same account for lofi.
// App scoping comes from the credential itself (bound to the app's origin).
const ACCOUNT_SECRET_SALT = new TextEncoder().encode("lofi:account-secret:v1");

/**
 * Derives the account secret **deterministically** from the passkey via PRF, in
 * Jazz's 32-byte base64url auth-secret format. The same portable credential
 * reconstructs the *same* account on any device — so the key is the account, and
 * the account lives wherever the key does. Nothing is stored server-side and no
 * recovery is implied: without the key, the account is gone.
 *
 * Requires a `stable` origin and a PRF-capable client; throws `origin-rejected`
 * or `prf-unavailable` otherwise (never a fabricated secret). Feed the result to
 * Jazz as the account secret (e.g. via `BrowserAuthSecretStore.saveSecret`).
 */
export async function deriveAuthSecret(dependencies: AuthDependencies = {}): Promise<string> {
  const prfSecret = await derivePrfSecret(ACCOUNT_SECRET_SALT, dependencies);
  return await hkdfAccountSecret(prfSecret);
}

// HKDF-SHA-256 expands the raw PRF secret into Jazz's 32-byte base64url
// auth-secret format. Kept separate so both `deriveAuthSecret` and
// `deriveAccount` produce byte-identical secrets from the same PRF result.
async function hkdfAccountSecret(prfSecret: Uint8Array): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    prfSecret as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("lofi:account-secret"),
    },
    material,
    256,
  );
  return toBase64Url(new Uint8Array(bits));
}

/** An account secret paired with the credential that unlocked it. */
export type PasskeyAccount = { secret: string; credential: DeviceCredential };

/**
 * Signs in with a passkey in **one** ceremony: derives the deterministic Jazz
 * account secret (as {@link deriveAuthSecret}) and reports the asserting
 * credential (its `rpId` and whether it is `portable`), so the UI can show which
 * key unlocked the account and whether it roams. Same guarantees and failures as
 * {@link deriveAuthSecret}: a `stable`/`local-only` origin and a PRF result, or a
 * thrown `origin-rejected` / `prf-unavailable` — never a fabricated secret.
 */
export async function deriveAccount(dependencies: AuthDependencies = {}): Promise<PasskeyAccount> {
  const { prfSecret, credential } = await prfAssertion(ACCOUNT_SECRET_SALT, dependencies);
  return { secret: await hkdfAccountSecret(prfSecret), credential };
}
