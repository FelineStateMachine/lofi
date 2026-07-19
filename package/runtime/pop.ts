/**
 * Proof-of-possession for sync tickets: the device generates a
 * non-extractable ECDSA P-256 keypair at enrollment, binds its public key to
 * the derived sync ticket at the node's scope-down exchange, and thereafter
 * answers a challenge with a fresh signature before connecting — the signing
 * key never leaves the device, so an exfiltrated ticket string alone no
 * longer connects. Losing the key (a wiped browser store) is not recoverable
 * by design; re-enrollment with a fresh ticket is the recovery.
 *
 * @module
 */

/** The device public key offered at the scope-down exchange. */
export type DevicePublicKey = {
  alg: "ES256";
  /** base64url DER SubjectPublicKeyInfo. */
  spki: string;
};

/** Storage for the device keypair; IndexedDB in browsers. */
export type PopKeyStore = {
  get(keyId: string): Promise<CryptoKeyPair | null>;
  put(keyId: string, pair: CryptoKeyPair): Promise<void>;
};

const POP_DB_NAME = "lofi-device-keys";
const POP_STORE_NAME = "keys";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(POP_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(POP_STORE_NAME)) {
        request.result.createObjectStore(POP_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("device key store failed to open"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("device key request failed"));
  });
}

function indexedDbPopKeyStore(): PopKeyStore {
  return {
    async get(keyId) {
      const db = await openDb();
      try {
        const stored = await requestToPromise<CryptoKeyPair | undefined>(
          db.transaction(POP_STORE_NAME, "readonly").objectStore(POP_STORE_NAME).get(keyId),
        );
        return stored ?? null;
      } finally {
        db.close();
      }
    },
    async put(keyId, pair) {
      const db = await openDb();
      try {
        await requestToPromise(
          db.transaction(POP_STORE_NAME, "readwrite").objectStore(POP_STORE_NAME).put(
            pair,
            keyId,
          ),
        );
      } finally {
        db.close();
      }
    },
  };
}

/** A process-lifetime store for tests and non-browser environments. */
export function memoryPopKeyStore(): PopKeyStore {
  const pairs = new Map<string, CryptoKeyPair>();
  return {
    get: (keyId) => Promise.resolve(pairs.get(keyId) ?? null),
    put: (keyId, pair) => {
      pairs.set(keyId, pair);
      return Promise.resolve();
    },
  };
}

let sharedStore: PopKeyStore | null = null;

/** The device keypair store for this runtime: IndexedDB where available. */
export function defaultPopKeyStore(): PopKeyStore {
  sharedStore ??= typeof indexedDB === "undefined" ? memoryPopKeyStore() : indexedDbPopKeyStore();
  return sharedStore;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The device keypair for an app's sync enrollment, minted on first use. The
 * private key is non-extractable — usable by this origin, exportable by
 * nobody.
 */
export async function getOrCreatePopKeyPair(
  appId: string,
  store: PopKeyStore = defaultPopKeyStore(),
): Promise<CryptoKeyPair> {
  const keyId = `pop:${appId}`;
  const existing = await store.get(keyId);
  if (existing) return existing;
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  await store.put(keyId, pair);
  return (await store.get(keyId)) ?? pair;
}

/** The offerable public half of a device keypair. */
export async function exportDevicePublicKey(pair: CryptoKeyPair): Promise<DevicePublicKey> {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return { alg: "ES256", spki: toBase64Url(spki) };
}

/** The exact bytes signed to prove possession; mirrors the node's contract. */
export function popMessage(appId: string, ticketId: string, nonce: string): Uint8Array {
  return new TextEncoder().encode(`lofisync-pop-v1\n${appId}\n${ticketId}\n${nonce}`);
}

/** Signs a challenge message with the device key (raw r||s, base64url). */
export async function signPopMessage(
  pair: CryptoKeyPair,
  message: Uint8Array,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    message.buffer as ArrayBuffer,
  );
  return toBase64Url(new Uint8Array(signature));
}

/**
 * Runs the pre-connect exchange against a bound ticket's base URL and
 * returns the token-suffixed server URL to hand to the sync client, or null
 * when the exchange fails — an expired knowledge (node restart), a revoked
 * ticket, or a node predating the exchange. Callers treat null like a
 * revoked ticket: surface re-enrollment, never retry silently forever.
 */
export async function completePopExchange(input: {
  serverUrl: string;
  appId: string;
  ticketId: string;
  keyPair: CryptoKeyPair;
  fetcher?: typeof fetch;
}): Promise<string | null> {
  const fetcher = input.fetcher ?? fetch;
  try {
    const challengeResponse = await fetcher(`${input.serverUrl}/pop/challenge`, {
      method: "POST",
    });
    if (!challengeResponse.ok) {
      await challengeResponse.body?.cancel();
      return null;
    }
    const challenge = await challengeResponse.json() as { id?: unknown; nonce?: unknown };
    if (typeof challenge.id !== "string" || typeof challenge.nonce !== "string") return null;
    const sig = await signPopMessage(
      input.keyPair,
      popMessage(input.appId, input.ticketId, challenge.nonce),
    );
    const answerResponse = await fetcher(`${input.serverUrl}/pop/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: 1, id: challenge.id, sig }),
    });
    if (!answerResponse.ok) {
      await answerResponse.body?.cancel();
      return null;
    }
    const answer = await answerResponse.json() as { connect?: unknown };
    if (typeof answer.connect !== "string" || !answer.connect) return null;
    return `${input.serverUrl}/c/${answer.connect}`;
  } catch {
    return null;
  }
}
