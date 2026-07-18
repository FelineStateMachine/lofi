/**
 * Package-owned at-rest envelope for secret-bearing runtime state.
 *
 * A random 32-byte data-encryption key (DEK) encrypts the payload once, and
 * the DEK is wrapped under one or more protector slots, so protectors can be
 * added or retried without re-encrypting the payload. Opening tries slots in
 * order and falls through on a protector that is unavailable, which is what
 * lets a passkey-PRF slot be attempted optimistically alongside a silent
 * device-key slot. The slot table and the envelope's purpose are bound to the
 * payload as authenticated data, so slots cannot be substituted after seal.
 *
 * Slot types and what they defend against:
 * - `device-key`: a non-extractable AES key kept in the device key store
 *   (IndexedDB in browsers). Opens with zero ceremony. Defends data at rest —
 *   disk images, backups, storage exfiltration — but not same-origin script,
 *   which can drive the silent open itself.
 * - `prf`: a key derived from a passkey's PRF output; opening is a
 *   user-verifying ceremony. Adds the interactive gate the device key cannot.
 *
 * @module
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** A DEK wrap under a silent, device-bound key from the {@link DeviceKeyStore}. */
export type DeviceKeySlot = {
  /** Discriminates the protector kind. */
  type: "device-key";
  /** Names the wrapping key in the device key store. */
  keyId: string;
  /** Base64url AES-GCM IV of the DEK wrap. */
  iv: string;
  /** Base64url AES-GCM ciphertext of the DEK. */
  wrappedDek: string;
};

/** A DEK wrap under a key derived from a passkey's PRF output. */
export type PrfSlot = {
  /** Discriminates the protector kind. */
  type: "prf";
  /** Base64url credential id of the passkey that evaluated the PRF. */
  credentialId: string;
  /** Base64url PRF evaluation input; fixed per slot so the output is stable. */
  prfSalt: string;
  /** Base64url HKDF salt turning the PRF output into the wrapping key. */
  hkdfSalt: string;
  /** Whether the credential syncs across devices (affects where this slot opens). */
  portable?: boolean;
  /** Base64url AES-GCM IV of the DEK wrap. */
  iv: string;
  /** Base64url AES-GCM ciphertext of the DEK. */
  wrappedDek: string;
};

/** One protector's wrap of the envelope DEK. */
export type EnvelopeSlot = DeviceKeySlot | PrfSlot;

/** Slot metadata a caller supplies at seal time; wrap fields are computed. */
export type SlotDescriptor =
  | Omit<DeviceKeySlot, "iv" | "wrappedDek">
  | Omit<PrfSlot, "iv" | "wrappedDek">;

/** A protector at seal time: the slot metadata plus its wrapping key. */
export type EnvelopeProtector = {
  /** Persisted slot metadata identifying how to re-derive the wrapping key. */
  slot: SlotDescriptor;
  /** AES-GCM key that wraps the DEK for this slot. */
  key: CryptoKey;
};

/** The persisted envelope: versioned, purpose-bound, self-describing. */
export type SealedEnvelope = {
  /** Envelope format version. */
  v: 1;
  /** Domain-separation string; opening under a different purpose fails. */
  purpose: string;
  /** DEK wraps, tried in order at open time. */
  slots: EnvelopeSlot[];
  /** Base64url AES-GCM IV of the payload encryption. */
  iv: string;
  /** Base64url AES-GCM ciphertext of the payload. */
  ciphertext: string;
};

/** Raised when an envelope cannot be opened or is not a valid envelope. */
export class EnvelopeError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "EnvelopeError";
  /**
   * `locked` — no supplied protector could unwrap the DEK (the data is intact
   * but this context lacks a key). `corrupt` — the envelope failed
   * authentication or validation (tampered, truncated, or wrong purpose).
   */
  readonly code: "locked" | "corrupt";
  /** Creates an envelope failure with a stable category. */
  constructor(code: "locked" | "corrupt", message: string) {
    super(message);
    this.code = code;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Key-order-independent serialization so the authenticated data recomputed at
// open time matches the seal regardless of how the stored JSON round-tripped.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${
      entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(value);
}

function payloadAad(purpose: string, slots: EnvelopeSlot[]): Uint8Array {
  return textEncoder.encode(canonicalJson({ v: 1, purpose, slots }));
}

function slotAad(purpose: string, type: EnvelopeSlot["type"]): Uint8Array {
  return textEncoder.encode(`lofi-envelope/1:${purpose}:slot:${type}`);
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function importDek(raw: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Seals `payload` under every supplied protector. At least one protector is
 * required — an envelope nobody can open is a bug, not a security posture.
 */
export async function sealEnvelope(
  purpose: string,
  payload: Uint8Array,
  protectors: readonly EnvelopeProtector[],
): Promise<SealedEnvelope> {
  if (protectors.length === 0) {
    throw new EnvelopeError("corrupt", "sealing needs at least one protector");
  }
  const dekRaw = randomBytes(32);
  const slots: EnvelopeSlot[] = [];
  for (const protector of protectors) {
    const iv = randomBytes(12);
    const wrapped = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: slotAad(purpose, protector.slot.type) as BufferSource,
      },
      protector.key,
      dekRaw as BufferSource,
    );
    slots.push({
      ...protector.slot,
      iv: toBase64Url(iv),
      wrappedDek: toBase64Url(new Uint8Array(wrapped)),
    } as EnvelopeSlot);
  }
  const dek = await importDek(dekRaw);
  dekRaw.fill(0);
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: payloadAad(purpose, slots) as BufferSource,
    },
    dek,
    payload as BufferSource,
  );
  return {
    v: 1,
    purpose,
    slots,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  };
}

/**
 * Opens an envelope by trying each slot in order. `resolveKey` returns the
 * wrapping key for a slot, or `null` when that protector is unavailable in
 * this context (missing device key, PRF declined) — the next slot is tried.
 * Throws `locked` when no slot opens and `corrupt` for a tampered or
 * wrong-purpose envelope.
 */
export async function openEnvelope(
  purpose: string,
  envelope: SealedEnvelope,
  resolveKey: (slot: EnvelopeSlot) => Promise<CryptoKey | null>,
): Promise<Uint8Array> {
  if (envelope.v !== 1) {
    throw new EnvelopeError("corrupt", `unsupported envelope version ${envelope.v}`);
  }
  if (envelope.purpose !== purpose) {
    throw new EnvelopeError(
      "corrupt",
      `envelope purpose "${envelope.purpose}" does not match "${purpose}"`,
    );
  }
  for (const slot of envelope.slots) {
    const key = await resolveKey(slot);
    if (!key) continue;
    let dekRaw: Uint8Array;
    try {
      dekRaw = new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: fromBase64Url(slot.iv) as BufferSource,
            additionalData: slotAad(purpose, slot.type) as BufferSource,
          },
          key,
          fromBase64Url(slot.wrappedDek) as BufferSource,
        ),
      );
    } catch {
      // A wrap that does not authenticate under this key is treated as an
      // unavailable protector (a rotated or foreign key), not fatal.
      continue;
    }
    const dek = await importDek(dekRaw);
    dekRaw.fill(0);
    try {
      return new Uint8Array(
        await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: fromBase64Url(envelope.iv) as BufferSource,
            additionalData: payloadAad(purpose, envelope.slots) as BufferSource,
          },
          dek,
          fromBase64Url(envelope.ciphertext) as BufferSource,
        ),
      );
    } catch {
      // The slot authenticated its DEK but the payload does not authenticate:
      // the envelope body was tampered with or truncated.
      throw new EnvelopeError("corrupt", "envelope payload failed authentication");
    }
  }
  throw new EnvelopeError("locked", "no available protector opens this envelope");
}

/** Seals a UTF-8 JSON payload; see {@link sealEnvelope}. */
export async function sealJsonEnvelope(
  purpose: string,
  payload: unknown,
  protectors: readonly EnvelopeProtector[],
): Promise<SealedEnvelope> {
  return await sealEnvelope(purpose, textEncoder.encode(JSON.stringify(payload)), protectors);
}

/** Opens a UTF-8 JSON payload; see {@link openEnvelope}. */
export async function openJsonEnvelope(
  purpose: string,
  envelope: SealedEnvelope,
  resolveKey: (slot: EnvelopeSlot) => Promise<CryptoKey | null>,
): Promise<unknown> {
  const payload = await openEnvelope(purpose, envelope, resolveKey);
  try {
    return JSON.parse(textDecoder.decode(payload));
  } catch {
    throw new EnvelopeError("corrupt", "envelope payload is not JSON");
  }
}

/** Validates an untrusted parsed value as a v1 envelope, or returns `null`. */
export function parseSealedEnvelope(value: unknown): SealedEnvelope | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Partial<SealedEnvelope>;
  if (
    record.v !== 1 || typeof record.purpose !== "string" ||
    typeof record.iv !== "string" || typeof record.ciphertext !== "string" ||
    !Array.isArray(record.slots)
  ) {
    return null;
  }
  for (const slot of record.slots) {
    if (slot === null || typeof slot !== "object") return null;
    const candidate = slot as Partial<EnvelopeSlot>;
    if (typeof candidate.iv !== "string" || typeof candidate.wrappedDek !== "string") return null;
    if (candidate.type === "device-key") {
      if (typeof (candidate as Partial<DeviceKeySlot>).keyId !== "string") return null;
    } else if (candidate.type === "prf") {
      const prf = candidate as Partial<PrfSlot>;
      if (
        typeof prf.credentialId !== "string" || typeof prf.prfSalt !== "string" ||
        typeof prf.hkdfSalt !== "string"
      ) {
        return null;
      }
    } else {
      return null;
    }
  }
  return value as SealedEnvelope;
}

/**
 * Holds the non-extractable device-bound wrapping keys for `device-key`
 * slots. Browsers back this with IndexedDB; non-browser runtimes and tests
 * get an in-memory store.
 */
export interface DeviceKeyStore {
  /** Returns the wrapping key for `keyId`, creating it when absent. */
  getOrCreate(keyId: string): Promise<CryptoKey>;
  /** Returns the wrapping key for `keyId`, or `null` when the store lost it. */
  get(keyId: string): Promise<CryptoKey | null>;
}

function generateDeviceKey(): Promise<CryptoKey> {
  // Non-extractable: same-origin script can use the key while the page runs,
  // but cannot export it — the at-rest copy in IndexedDB is all there is.
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Creates an in-memory device key store (non-browser runtimes and tests). */
export function memoryDeviceKeyStore(): DeviceKeyStore {
  const keys = new Map<string, CryptoKey>();
  return {
    async getOrCreate(keyId) {
      const existing = keys.get(keyId);
      if (existing) return existing;
      const created = await generateDeviceKey();
      keys.set(keyId, created);
      return created;
    },
    get(keyId) {
      return Promise.resolve(keys.get(keyId) ?? null);
    },
  };
}

const deviceKeyDbName = "lofi-device-keys";
const deviceKeyStoreName = "keys";

function openDeviceKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(deviceKeyDbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(deviceKeyStoreName)) {
        request.result.createObjectStore(deviceKeyStoreName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("device key store failed to open"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("device key store request failed"));
  });
}

/** Creates the browser device key store backed by IndexedDB. */
export function indexedDbDeviceKeyStore(): DeviceKeyStore {
  async function read(keyId: string): Promise<CryptoKey | null> {
    const db = await openDeviceKeyDb();
    try {
      const stored = await requestToPromise<CryptoKey | undefined>(
        db.transaction(deviceKeyStoreName, "readonly").objectStore(deviceKeyStoreName).get(keyId),
      );
      return stored ?? null;
    } finally {
      db.close();
    }
  }
  async function write(keyId: string, key: CryptoKey): Promise<void> {
    const db = await openDeviceKeyDb();
    try {
      await requestToPromise(
        db.transaction(deviceKeyStoreName, "readwrite").objectStore(deviceKeyStoreName).put(
          key,
          keyId,
        ),
      );
    } finally {
      db.close();
    }
  }
  return {
    async getOrCreate(keyId) {
      const existing = await read(keyId);
      if (existing) return existing;
      const created = await generateDeviceKey();
      await write(keyId, created);
      // Re-read so two racing tabs converge on whichever write landed last;
      // both copies wrap the same envelope generation only after reseal, so
      // the loser's envelope stays openable via the winner's key.
      return (await read(keyId)) ?? created;
    },
    get(keyId) {
      return read(keyId);
    },
  };
}

let sharedDefaultStore: DeviceKeyStore | null = null;

/**
 * The device key store for this runtime: IndexedDB in browsers, a
 * process-lifetime in-memory store elsewhere. One shared instance, so
 * sealing and opening in the same session agree on keys.
 */
export function defaultDeviceKeyStore(): DeviceKeyStore {
  sharedDefaultStore ??= typeof indexedDB === "undefined"
    ? memoryDeviceKeyStore()
    : indexedDbDeviceKeyStore();
  return sharedDefaultStore;
}

/** Builds the seal-time protector for a `device-key` slot. */
export async function deviceKeyProtector(
  store: DeviceKeyStore,
  keyId: string,
): Promise<EnvelopeProtector> {
  return { slot: { type: "device-key", keyId }, key: await store.getOrCreate(keyId) };
}

/** Builds an open-time resolver that answers only `device-key` slots. */
export function deviceKeyResolver(
  store: DeviceKeyStore,
): (slot: EnvelopeSlot) => Promise<CryptoKey | null> {
  return (slot) => (slot.type === "device-key" ? store.get(slot.keyId) : Promise.resolve(null));
}
