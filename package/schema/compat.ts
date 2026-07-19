/**
 * Revision↔schema compatibility: the manifest a build stamps next to its
 * service worker, and the classification the boot gate runs against the
 * schema version recorded beside the local data.
 *
 * The bundle and the data version independently, so an offline shell can be
 * older than the data another tab or device migrated. The fingerprint here is
 * lofi-owned and deliberately independent of the sync server's schema hash:
 * both sides of every comparison — the built manifest and the local stamp —
 * are produced by this module, so the only requirement is that the
 * normalization stays stable across releases. The `v1:` prefix names that
 * normalization; a future change ships as `v2:` and classifies against `v1:`
 * values as unrelated rather than silently equal.
 *
 * @module
 */

import { nestedAppDeployTarget, nestedAppTables } from "./nested.ts";

/** The schema range one build understands: its head and every known ancestor. */
export type SchemaVersionRange = {
  /** The fingerprint of the schema this build compiles against. */
  head: string;
  /** Fingerprints of the head and every ancestor schema (migration lineage). */
  lineage: readonly string[];
};

/** The build-stamped compatibility manifest (`dist/lofi-schema.json`). */
export type SchemaCompatManifest = SchemaVersionRange & {
  /** Manifest format version. */
  v: 1;
  /** The build revision the schema range belongs to (the source hash). */
  revision: string;
};

/**
 * How one build's supported schema range relates to the version the local
 * data was last written under.
 */
export type SchemaCompatClassification =
  /** No recorded local version — nothing constrains this build. */
  | "first-boot"
  /** The local data and this build share one schema head. */
  | "equal"
  /** This build's lineage contains the local version: migrations run forward. */
  | "code-ahead"
  /** The local data's lineage contains this build's head: the data is newer. */
  | "data-ahead"
  /** Neither range contains the other; treat like newer data, never write. */
  | "unrelated";

// Canonical JSON: object keys sorted recursively, `undefined` entries dropped
// exactly as JSON serialization drops them (so an in-memory schema and its
// JSON snapshot fingerprint identically), and any `columns` array sorted by
// column name — the engine treats column order as insignificant, so the
// fingerprint must too. Everything else keeps its value verbatim.
function canonicalize(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalize(entry) ?? null);
    if (key === "columns") {
      entries.sort((left, right) => {
        const leftName = (left as { name?: unknown })?.name;
        const rightName = (right as { name?: unknown })?.name;
        return String(leftName).localeCompare(String(rightName));
      });
    }
    return entries;
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const name of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = canonicalize((value as Record<string, unknown>)[name], name);
      if (entry !== undefined) sorted[name] = entry;
    }
    return sorted;
  }
  return value;
}

/**
 * Computes the stable lofi fingerprint of one compiled (wasm-form) schema:
 * `v1:` plus 16 hex characters of the SHA-256 of the canonicalized schema.
 */
export async function computeSchemaFingerprint(
  wasmSchema: Record<string, unknown>,
): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify(canonicalize(wasmSchema)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(digest.slice(0, 8))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `v1:${hex}`;
}

/**
 * The compiled wasm-form schema of an app value: a flat `defineApp` result
 * carries it directly, a nested root exposes it through its deploy target.
 * Throws when the value is neither.
 */
export function resolveAppWasmSchema(app: unknown): Record<string, unknown> {
  if (app && typeof app === "object") {
    if (nestedAppTables(app) !== null) {
      const target = nestedAppDeployTarget(app) as { wasmSchema?: Record<string, unknown> };
      if (target.wasmSchema) return target.wasmSchema;
    }
    const wasmSchema = (app as { wasmSchema?: unknown }).wasmSchema;
    if (wasmSchema && typeof wasmSchema === "object") {
      return wasmSchema as Record<string, unknown>;
    }
  }
  throw new Error(
    "schema compatibility requires an app value from s.defineApp or s.defineNestedApp",
  );
}

/**
 * Builds the schema version range for one app: the head fingerprint plus the
 * fingerprints of every ancestor schema (the committed migration snapshots).
 * The head is always part of the lineage; ancestor order is not significant —
 * classification is containment, not ordering.
 */
export async function buildSchemaVersionRange(
  app: unknown,
  ancestorSchemas: readonly Record<string, unknown>[] = [],
): Promise<SchemaVersionRange> {
  const head = await computeSchemaFingerprint(resolveAppWasmSchema(app));
  const lineage = new Set<string>();
  for (const ancestor of ancestorSchemas) {
    lineage.add(await computeSchemaFingerprint(ancestor));
  }
  lineage.add(head);
  return { head, lineage: [...lineage].sort() };
}

/**
 * Classifies one build's supported schema range against the version range
 * recorded beside the local data. Containment decides direction: a build
 * whose lineage includes the local head is ahead of the data (migrations run
 * as usual), a local record whose lineage includes the build's head was
 * stamped by a newer build (the data is ahead), and two ranges that contain
 * neither head are unrelated.
 */
export function classifySchemaCompat(
  bundle: SchemaVersionRange,
  local: SchemaVersionRange | null,
): SchemaCompatClassification {
  if (!local) return "first-boot";
  if (local.head === bundle.head) return "equal";
  if (bundle.lineage.includes(local.head)) return "code-ahead";
  if (local.lineage.includes(bundle.head)) return "data-ahead";
  return "unrelated";
}

function isVersionRange(value: unknown): value is SchemaVersionRange {
  if (!value || typeof value !== "object") return false;
  const range = value as { head?: unknown; lineage?: unknown };
  return typeof range.head === "string" && range.head.length > 0 &&
    Array.isArray(range.lineage) &&
    range.lineage.every((entry) => typeof entry === "string") &&
    range.lineage.includes(range.head);
}

/** Parses an untrusted manifest value; `null` when the shape is not usable. */
export function parseSchemaCompatManifest(value: unknown): SchemaCompatManifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as { v?: unknown; revision?: unknown };
  if (manifest.v !== 1 || typeof manifest.revision !== "string") return null;
  if (!isVersionRange(value)) return null;
  const range = value as SchemaVersionRange;
  return { v: 1, revision: manifest.revision, head: range.head, lineage: [...range.lineage] };
}

/** Parses a persisted local schema-version record; `null` when unusable. */
export function parseLocalSchemaVersion(value: unknown): SchemaVersionRange | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as { v?: unknown };
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    if (!isVersionRange(parsed)) return null;
    const range = parsed as unknown as SchemaVersionRange;
    return { head: range.head, lineage: [...range.lineage] };
  } catch {
    return null;
  }
}

/** Serializes a local schema-version record for persistence beside the store. */
export function serializeLocalSchemaVersion(range: SchemaVersionRange): string {
  return JSON.stringify({ v: 1, head: range.head, lineage: [...range.lineage] });
}
