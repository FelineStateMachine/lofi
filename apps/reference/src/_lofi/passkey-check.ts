import { assertStableCredentialOrigin } from "./device-capabilities.ts";

const TEST_CREDENTIAL_ID = "lofi:device-check:credential-id";

type PasskeyDependencies = {
  credentials?: CredentialsContainer;
  storage?: Storage;
  rpId?: string;
};

export type PasskeyCheckResult = {
  status: "created" | "retrieved" | "sibling-rejected";
  rpId: string;
};

export class PasskeyCheckError extends Error {
  override name = "PasskeyCheckError";
  readonly code:
    | "cancelled"
    | "credential-missing"
    | "credential-mismatch"
    | "origin-rejected"
    | "sibling-accepted"
    | "unsupported"
    | "unknown";

  constructor(code: PasskeyCheckError["code"]) {
    super(`Test passkey check failed: ${code}.`);
    this.code = code;
  }
}

function randomBytes(length = 32): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function rawCredentialId(credential: Credential | null): Uint8Array<ArrayBuffer> {
  if (!credential || !("rawId" in credential) || !(credential.rawId instanceof ArrayBuffer)) {
    throw new PasskeyCheckError("credential-missing");
  }
  return new Uint8Array(credential.rawId);
}

function browserCredentials(): CredentialsContainer {
  if (typeof navigator === "undefined" || !navigator.credentials) {
    throw new PasskeyCheckError("unsupported");
  }
  return navigator.credentials;
}

function browserStorage(): Storage {
  if (typeof localStorage === "undefined") throw new PasskeyCheckError("unsupported");
  return localStorage;
}

function safePasskeyError(error: unknown): PasskeyCheckError {
  if (error instanceof PasskeyCheckError) return error;
  const name = typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "";
  if (name === "NotAllowedError") return new PasskeyCheckError("cancelled");
  if (name === "SecurityError") return new PasskeyCheckError("origin-rejected");
  if (name === "NotSupportedError") return new PasskeyCheckError("unsupported");
  return new PasskeyCheckError("unknown");
}

export function passkeyCreationOptions(
  rpId: string,
  challenge = randomBytes(),
  userId = randomBytes(),
): PublicKeyCredentialCreationOptions {
  return {
    rp: { id: rpId, name: "lofi device check" },
    user: {
      id: userId,
      name: "lofi-device-check",
      displayName: "lofi device check",
    },
    challenge,
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
  };
}

export function passkeyRequestOptions(
  rpId: string,
  challenge = randomBytes(),
): PublicKeyCredentialRequestOptions {
  return {
    rpId,
    challenge,
    userVerification: "required",
    timeout: 60_000,
  };
}

export function siblingRpId(rpId: string): string {
  const labels = rpId.split(".");
  if (labels.length < 2) return `invalid-sibling.${rpId}`;
  labels[0] = "invalid-sibling";
  return labels.join(".");
}

export function hasStoredTestPasskey(storage: Storage = browserStorage()): boolean {
  try {
    return Boolean(storage.getItem(TEST_CREDENTIAL_ID));
  } catch {
    return false;
  }
}

export async function createTestPasskey(
  dependencies: PasskeyDependencies = {},
): Promise<PasskeyCheckResult> {
  const rpId = dependencies.rpId ?? assertStableCredentialOrigin();
  const credentials = dependencies.credentials ?? browserCredentials();
  const storage = dependencies.storage ?? browserStorage();
  try {
    const credential = await credentials.create({ publicKey: passkeyCreationOptions(rpId) });
    storage.setItem(TEST_CREDENTIAL_ID, encodeBase64Url(rawCredentialId(credential)));
    return { status: "created", rpId };
  } catch (error) {
    throw safePasskeyError(error);
  }
}

export async function retrieveTestPasskey(
  dependencies: PasskeyDependencies = {},
): Promise<PasskeyCheckResult> {
  const rpId = dependencies.rpId ?? assertStableCredentialOrigin();
  const credentials = dependencies.credentials ?? browserCredentials();
  const storage = dependencies.storage ?? browserStorage();
  const stored = storage.getItem(TEST_CREDENTIAL_ID);
  if (!stored) throw new PasskeyCheckError("credential-missing");
  try {
    const credential = await credentials.get({ publicKey: passkeyRequestOptions(rpId) });
    if (encodeBase64Url(rawCredentialId(credential)) !== stored) {
      throw new PasskeyCheckError("credential-mismatch");
    }
    return { status: "retrieved", rpId };
  } catch (error) {
    throw safePasskeyError(error);
  }
}

export async function verifySiblingRpRejected(
  dependencies: PasskeyDependencies = {},
): Promise<PasskeyCheckResult> {
  const rpId = dependencies.rpId ?? assertStableCredentialOrigin();
  const credentials = dependencies.credentials ?? browserCredentials();
  try {
    await credentials.get({
      publicKey: {
        rpId: siblingRpId(rpId),
        challenge: randomBytes(),
        userVerification: "required",
        timeout: 10_000,
      },
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "name" in error) {
      if (String(error.name) === "SecurityError") return { status: "sibling-rejected", rpId };
    }
    throw safePasskeyError(error);
  }
  throw new PasskeyCheckError("sibling-accepted");
}
