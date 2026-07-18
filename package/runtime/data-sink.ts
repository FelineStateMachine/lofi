/**
 * Package-owned data-sink state: the user-declared sync location.
 *
 * A data sink names where this account's data syncs — a Jazz appId plus a
 * server URL — as **user-selected data, not developer configuration**. First
 * boot needs no sink and stays local-only; a deployment may still compile in
 * a managed Jazz app, which acts as the *default* sink. Declaring a sink at
 * runtime (typically by enrolling a `lofisync1.` app-connect ticket issued by
 * a self-hosted node) overrides the default for this device.
 *
 * The ticket URL is a bearer credential, so the declaration never touches
 * storage in cleartext: it persists as a sealed envelope (see `envelope.ts`)
 * under a silent device-bound key. That protects the record at rest — disk
 * images, backups, storage exfiltration — while opening with zero ceremony;
 * it does not defend against same-origin script, which can drive the silent
 * open itself. Boot unseals the record once into module memory
 * ({@link restoreDeclaredSink}), and every synchronous reader answers from
 * that state. The recovery envelope carrying the sink behind the passkey is
 * separate, follow-on work.
 *
 * @module
 */

import {
  defaultDeviceKeyStore,
  deviceKeyProtector,
  deviceKeyResolver,
  type DeviceKeyStore,
  EnvelopeError,
  openJsonEnvelope,
  parseSealedEnvelope,
  sealJsonEnvelope,
} from "./envelope.ts";

declare const __LOFI_JAZZ_APP_ID__: string;
declare const __LOFI_JAZZ_SERVER_URL__: string;

/**
 * The app id that anchors device-local state before (or without) a managed
 * app: storage keys, the account secret store, and the local database
 * namespace all key off the anchor so they survive a sink being declared
 * later.
 */
export const LOCAL_APP_ID = "00000000-0000-0000-0000-00000000f153";

/** The build-time Jazz app id, or the empty string when none was configured. */
export const configuredAppId: string = typeof __LOFI_JAZZ_APP_ID__ === "string"
  ? __LOFI_JAZZ_APP_ID__
  : "";

/** The build-time Jazz server URL, or the empty string when none was configured. */
export const configuredServerUrl: string = typeof __LOFI_JAZZ_SERVER_URL__ === "string"
  ? __LOFI_JAZZ_SERVER_URL__
  : "";

/**
 * The device-local anchor app id: the build-time app id when one exists,
 * otherwise {@link LOCAL_APP_ID}. Every localStorage key and the secret store
 * key off this value, so a runtime-declared sink never orphans state written
 * before the declaration.
 */
export const anchorAppId: string = configuredAppId || LOCAL_APP_ID;

/** A user-declared sync location: where this account's data syncs. */
export type DataSinkDeclaration = {
  /** The Jazz app id of the target store. */
  appId: string;
  /** The http(s) sync server URL, used verbatim (a ticket URL keeps its secret path). */
  serverUrl: string;
  /**
   * The enrolled ticket's capability: `sync` is transport only; `provision`
   * additionally administers the store through the node's gate (the admin
   * secret never transits the client). Absent means `sync`.
   */
  scope?: "sync" | "provision";
  /** Optional user-facing label, e.g. the ticket's device label. */
  label?: string;
  /**
   * Opaque forward-compat carrier: the node's iroh endpoint ticket from a
   * `lofisync1.` app ticket. Unused by the browser runtime today.
   */
  node?: string;
};

/** Raised when a sink declaration or sync ticket is rejected. */
export class DataSinkError extends Error {
  /** Stable error class name for diagnostics and error boundaries. */
  override readonly name = "DataSinkError";
  /** Stable category for user-facing enrollment flows. */
  readonly code:
    | "invalid-ticket"
    | "invalid-server-url"
    | "app-id-mismatch"
    | "sink-already-declared";
  /** Creates a sink rejection with a stable category. */
  constructor(
    code: "invalid-ticket" | "invalid-server-url" | "app-id-mismatch" | "sink-already-declared",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const sinkKey = `lofi:data-sink:${anchorAppId}`;
const sinkPurpose = `lofi:data-sink:${anchorAppId}`;
const sinkDeviceKeyId = `data-sink:${anchorAppId}`;

// The declaration in effect for this document, populated by
// restoreDeclaredSink at boot and by successful declarations afterwards.
// Synchronous readers answer from here; storage holds only the envelope.
let cachedSink: DataSinkDeclaration | null = null;

function validateDeclaration(value: unknown): DataSinkDeclaration | null {
  if (value === null || typeof value !== "object") return null;
  const sink = value as Partial<DataSinkDeclaration>;
  if (
    typeof sink.appId !== "string" || !sink.appId ||
    typeof sink.serverUrl !== "string" || !sink.serverUrl
  ) {
    return null;
  }
  return {
    appId: sink.appId,
    serverUrl: sink.serverUrl,
    ...(sink.scope === "provision" || sink.scope === "sync" ? { scope: sink.scope } : {}),
    ...(typeof sink.label === "string" ? { label: sink.label } : {}),
    ...(typeof sink.node === "string" ? { node: sink.node } : {}),
  };
}

async function persistSealed(
  declaration: DataSinkDeclaration,
  keyStore: DeviceKeyStore,
): Promise<void> {
  if (typeof localStorage === "undefined") return;
  try {
    const sealed = await sealJsonEnvelope(sinkPurpose, declaration, [
      await deviceKeyProtector(keyStore, sinkDeviceKeyId),
    ]);
    localStorage.setItem(sinkKey, JSON.stringify({ v: 2, sealed }));
  } catch {
    // A private-mode storage failure must not break enrollment; the sink then
    // lasts for this document only via the in-memory declaration.
  }
}

/**
 * How {@link restoreDeclaredSink} resolved the persisted record: `none` (no
 * record), `restored` (envelope opened), `migrated` (a pre-envelope cleartext
 * record was read and resealed), or `unopenable` (an envelope exists but no
 * available key opens it — the record is left intact and the device behaves
 * as local-only until the sink is re-declared).
 */
export type SinkRestoreOutcome = "none" | "restored" | "migrated" | "unopenable";

/**
 * Unseals the persisted declaration into memory. Boot awaits this before any
 * sync decision (see `boot.ts`); tests and non-boot embedders call it
 * directly. Safe to call repeatedly — it re-reads storage each time.
 */
export async function restoreDeclaredSink(
  keyStore: DeviceKeyStore = defaultDeviceKeyStore(),
): Promise<SinkRestoreOutcome> {
  cachedSink = null;
  if (typeof localStorage === "undefined") return "none";
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(sinkKey);
  } catch {
    return "none";
  }
  if (!raw) return "none";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "none";
  }
  const record = parsed as { v?: number; sink?: unknown; sealed?: unknown } | null;
  if (record?.v === 1) {
    // A record from before the envelope: adopt it, then reseal so the
    // cleartext bearer URL leaves storage on the first boot that can.
    const sink = validateDeclaration(record.sink);
    if (!sink) return "none";
    cachedSink = sink;
    await persistSealed(sink, keyStore);
    return "migrated";
  }
  if (record?.v === 2) {
    const sealed = parseSealedEnvelope(record.sealed);
    if (!sealed) return "unopenable";
    try {
      const payload = await openJsonEnvelope(sinkPurpose, sealed, deviceKeyResolver(keyStore));
      const sink = validateDeclaration(payload);
      if (!sink) return "unopenable";
      cachedSink = sink;
      return "restored";
    } catch (error) {
      if (error instanceof EnvelopeError) return "unopenable";
      throw error;
    }
  }
  return "none";
}

/**
 * Reads the declared sink, or `null` when this device has not declared one.
 * Answers from the state restored at boot; callers outside the booted app
 * (tests, embedders) await {@link restoreDeclaredSink} first.
 */
export function readDeclaredSink(): DataSinkDeclaration | null {
  return cachedSink;
}

function assertHttpServerUrl(serverUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new DataSinkError("invalid-server-url", `sink server URL is not a URL: ${serverUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    // The browser client derives its own WebSocket endpoint from an http(s)
    // base; a ws:// URL here would bypass that derivation and lose the
    // ticket's base path.
    throw new DataSinkError(
      "invalid-server-url",
      `sink server URL must be http(s), received ${parsed.protocol}`,
    );
  }
}

/**
 * Declares the sync location for this device. Validates the URL, refuses an
 * app id that contradicts a compiled-in managed app, and refuses to replace a
 * different declared sink (one store, one active sink — clear the existing
 * declaration first; switching stores is deliberately not a silent overwrite).
 * Re-declaring the same store updates the label. The declaration persists as
 * a sealed envelope; in a context that cannot store it (private mode) it
 * lasts for this document only. Declaration alone changes no runtime state;
 * electing sync (see `session.ts`) is what connects.
 */
export async function declareDataSink(
  declaration: DataSinkDeclaration,
  keyStore: DeviceKeyStore = defaultDeviceKeyStore(),
): Promise<DataSinkDeclaration> {
  if (!declaration.appId.trim()) {
    throw new DataSinkError("invalid-ticket", "sink app id must not be empty");
  }
  assertHttpServerUrl(declaration.serverUrl);
  if (configuredAppId && declaration.appId !== configuredAppId) {
    throw new DataSinkError(
      "app-id-mismatch",
      "this deployment is pinned to its own managed app; the sink's app id does not match",
    );
  }
  const current = readDeclaredSink();
  if (
    current && (current.appId !== declaration.appId || current.serverUrl !== declaration.serverUrl)
  ) {
    throw new DataSinkError(
      "sink-already-declared",
      "a different sink is already declared on this device; clear it before declaring another",
    );
  }
  await persistSealed(declaration, keyStore);
  cachedSink = declaration;
  return declaration;
}

/** Removes the declared sink. Existing local data and elections are untouched. */
export function clearDeclaredSink(): void {
  cachedSink = null;
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(sinkKey);
  } catch {
    // A private-mode storage failure leaves the previous declaration in place.
  }
}

/**
 * A parsed `lofisync1.` app-connect ticket — the credential a self-hosted
 * node issues so an app syncs against it. The format contract lives with the
 * node (lofi-node `docs/app-ticket.md`, conformance fixtures vendored at
 * `package/testdata/app-ticket-fixtures.json`); this parser mirrors its
 * validation: version 1, an http(s) URL whose path is
 * `/t/<43-char base64url secret>`, and a `scope` that is absent (meaning
 * `sync`), `sync`, or `provision` — an unknown scope rejects the ticket
 * rather than silently granting less than it claims.
 */
export type SyncTicket = {
  v: 1;
  appId: string;
  url: string;
  scope?: "sync" | "provision";
  label?: string;
  node?: string;
};

const TICKET_PREFIX = "lofisync1.";
const TICKET_PATH = /^\/t\/[A-Za-z0-9_-]{43}$/;

/**
 * Parses a pasted or scanned app-connect ticket. Returns `null` on any
 * malformed input — paste paths never throw. The ticket URL is a bearer
 * credential: hold it only as long as enrollment needs it.
 */
export function parseSyncTicket(text: string): SyncTicket | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(TICKET_PREFIX)) return null;
  try {
    const base64 = trimmed.slice(TICKET_PREFIX.length)
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const parsed = JSON.parse(atob(base64)) as SyncTicket;
    if (parsed.v !== 1 || typeof parsed.appId !== "string" || typeof parsed.url !== "string") {
      return null;
    }
    if (
      parsed.scope !== undefined && parsed.scope !== "sync" && parsed.scope !== "provision"
    ) {
      return null;
    }
    const url = new URL(parsed.url);
    if (!/^https?:$/.test(url.protocol) || !TICKET_PATH.test(url.pathname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Converts a ticket into a sink declaration and records it. Throws
 * {@link DataSinkError} with `invalid-ticket` for malformed tickets and the
 * declaration errors otherwise. Electing sync afterwards (see
 * `enrollSyncTicket` in `session.ts`) is what actually connects.
 */
export async function declareSinkFromTicket(
  text: string,
  keyStore: DeviceKeyStore = defaultDeviceKeyStore(),
): Promise<DataSinkDeclaration> {
  const ticket = parseSyncTicket(text);
  if (!ticket) {
    throw new DataSinkError("invalid-ticket", "not a valid lofisync1 app-connect ticket");
  }
  return await declareDataSink({
    appId: ticket.appId,
    serverUrl: ticket.url,
    ...(ticket.scope ? { scope: ticket.scope } : {}),
    ...(ticket.label ? { label: ticket.label } : {}),
    ...(ticket.node ? { node: ticket.node } : {}),
  }, keyStore);
}

/** True when an error is a data-sink or ticket problem the user can fix and retry. */
export function isDataSinkError(error: unknown): error is DataSinkError {
  return error instanceof DataSinkError;
}
