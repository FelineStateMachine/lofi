/**
// Package-owned identity and device-credential runtime.
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

import { getLofiApp } from "./app.ts";

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
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "AuthError";
  /** Actionable category that callers can map to user-facing guidance. */
  readonly code:
    | "cancelled"
    | "origin-rejected"
    | "unsupported"
    | "prf-unavailable"
    | "credential-missing"
    | "credential-mismatch"
    | "unknown";

  /** Creates a device-credential error without including credential material. */
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

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    throw new AuthError("credential-mismatch", "The pinned credential id is unreadable.");
  }
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
  trustedOrigins: readonly string[] = getLofiApp().credentialOrigins ?? [],
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
  const declared = trustedOrigins ?? getLofiApp().credentialOrigins ?? [];
  // No implicit trust: with an empty `credentialOrigins` allowlist, a deployed
  // HTTPS host classifies as `unverified` and enrollment refuses. Implicitly
  // trusting the served hostname made that refusal unreachable — a preview
  // host could mint credentials (and PRF-protected data) that strand the
  // moment the app moves to its production hostname. Development on
  // localhost stays `local-only` and keeps working without configuration.
  return classifyCredentialOrigin(url, declared);
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
  const app = getLofiApp();
  const rpId = requireStableRpId(options);
  const credentials = options.credentials ?? browserCredentials();
  const label = options.label ?? app.name;
  try {
    const credential = await credentials.create({
      publicKey: {
        rp: { id: rpId, name: app.name },
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

/** Options for {@link authenticateDeviceCredential}. */
export type AuthenticateOptions = AuthDependencies & {
  /**
   * The base64url id of the one enrolled credential this ceremony must assert.
   * When set, the request pins `allowCredentials` to it and the returned
   * assertion is verified against it — any other credential for the same RP ID
   * fails with `credential-mismatch` instead of passing as the enrolled one.
   */
  credentialId?: string;
};

/**
 * Authenticates with a device passkey (user-verifying). Pass `credentialId` to
 * pin the ceremony to one enrolled credential; without it the request is
 * discoverable and any resident credential for the RP ID can assert.
 */
export async function authenticateDeviceCredential(
  options: AuthenticateOptions = {},
): Promise<DeviceCredential> {
  const rpId = requireStableRpId(options);
  const credentials = options.credentials ?? browserCredentials();
  const allowCredentials: PublicKeyCredentialDescriptor[] | undefined = options.credentialId
    ? [{ type: "public-key", id: fromBase64Url(options.credentialId) }]
    : undefined;
  try {
    const credential = await credentials.get({
      publicKey: {
        rpId,
        challenge: randomBytes(),
        userVerification: "required",
        timeout: 60_000,
        ...(allowCredentials ? { allowCredentials } : {}),
      },
    });
    const asserted = { id: toBase64Url(rawId(credential)), rpId, portable: isPortable(credential) };
    // Verify the assertion even though `allowCredentials` was sent: the browser
    // allow-list is a request hint, not a caller-side guarantee.
    if (options.credentialId && asserted.id !== options.credentialId) {
      throw new AuthError(
        "credential-mismatch",
        "The asserting passkey is not the enrolled credential.",
      );
    }
    return asserted;
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Authenticates and derives the PRF secret in one user-verifying ceremony:
 * the PRF evaluation rides the assertion's extensions, so a flow that needs
 * both the asserted credential and a credential-bound key costs one prompt,
 * not two. Pass `credentialId` to pin the ceremony to one enrolled
 * credential. Throws `prf-unavailable` when the client or authenticator
 * returns no PRF result — the secret is never faked — and
 * `credential-mismatch` when a different credential asserts than the one
 * pinned.
 */
export async function authenticateAndDerivePrfSecret(
  salt: BufferSource,
  options: AuthenticateOptions = {},
): Promise<{ credential: DeviceCredential; secret: Uint8Array }> {
  const rpId = requireStableRpId(options);
  const credentials = options.credentials ?? browserCredentials();
  const allowCredentials: PublicKeyCredentialDescriptor[] | undefined = options.credentialId
    ? [{ type: "public-key", id: fromBase64Url(options.credentialId) }]
    : undefined;
  try {
    const credential = await credentials.get({
      publicKey: {
        rpId,
        challenge: randomBytes(),
        userVerification: "required",
        timeout: 60_000,
        ...(allowCredentials ? { allowCredentials } : {}),
        extensions: { prf: { eval: { first: salt } } } as RequestExtensions,
      },
    });
    const asserted = { id: toBase64Url(rawId(credential)), rpId, portable: isPortable(credential) };
    // Verify the assertion even though `allowCredentials` was sent: the browser
    // allow-list is a request hint, not a caller-side guarantee.
    if (options.credentialId && asserted.id !== options.credentialId) {
      throw new AuthError(
        "credential-mismatch",
        "The asserting passkey is not the enrolled credential.",
      );
    }
    const results =
      (credential as (Credential & { getClientExtensionResults?: () => { prf?: PrfResults } }))
        .getClientExtensionResults?.().prf?.results;
    if (!results?.first) throw new AuthError("prf-unavailable");
    // A copy, not a view: callers zero the secret after deriving from it, and
    // that must never reach through to the extension-result buffer.
    return { credential: asserted, secret: new Uint8Array(results.first.slice(0)) };
  } catch (error) {
    throw mapError(error);
  }
}

// --- PRF-derived at-rest key --------------------------------------------------

/**
 * Derives a credential-bound secret from the passkey via the WebAuthn PRF
 * extension in one user-verifying `get()`. The same `salt` on the same
 * authenticator yields the same 32-byte secret; it never leaves the device.
 * Throws `prf-unavailable` if the client or authenticator does not return a
 * PRF result — the secret is never faked.
 */
export async function derivePrfSecret(
  salt: BufferSource,
  dependencies: AuthDependencies = {},
): Promise<Uint8Array> {
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
    return new Uint8Array(results.first);
  } catch (error) {
    throw mapError(error);
  }
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

// Account identity is not derived from a credential in lofi. The account is a
// local-first secret (see `session.ts`), backed up by a recovery phrase and,
// optionally, protected at rest by the PRF key above. Deriving the *account*
// from a passkey was removed: it cannot preserve a pre-existing local-only
// account's data, since a derived key is a different account. This module stays
// a device-credential + at-rest-key primitive, nothing more.
