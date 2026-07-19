/**
 * Build-time generation of the revision↔schema compatibility manifest
 * (`dist/lofi-schema.json`).
 *
 * The head fingerprint comes from the project's own schema module, and the
 * lineage from the committed migration snapshots (each snapshot is a prior
 * schema in wasm form). Both are computable offline at build time; the boot
 * gate later compares the shipped range against the version recorded beside
 * the local data.
 *
 * @module
 */

import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSchemaVersionRange,
  resolveAppWasmSchema,
  type SchemaCompatManifest,
} from "../schema/compat.ts";
import { nestedAppTables } from "../schema/nested.ts";

function isAppValue(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (nestedAppTables(value) !== null) return true;
  const wasmSchema = (value as { wasmSchema?: unknown }).wasmSchema;
  return Boolean(wasmSchema && typeof wasmSchema === "object");
}

/**
 * Resolves the app value from a schema module's exports: the `app` export
 * when it is one, otherwise the single exported app-shaped value. Throws an
 * actionable error when none (or more than one candidate) is found.
 */
export function findSchemaAppExport(moduleExports: Record<string, unknown>): unknown {
  if (isAppValue(moduleExports.app)) return moduleExports.app;
  const candidates = Object.entries(moduleExports).filter(([, value]) => isAppValue(value));
  if (candidates.length === 1) return candidates[0][1];
  throw new Error(
    candidates.length === 0
      ? "src/schema.ts does not export an app value (s.defineApp or s.defineNestedApp); " +
        "the schema compatibility manifest needs one to fingerprint the schema"
      : `src/schema.ts exports several app values (${
        candidates.map(([name]) => name).join(", ")
      }); export the deployed one as \`app\``,
  );
}

async function readSnapshotSchemas(
  snapshotsDir: string,
): Promise<Record<string, unknown>[]> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(snapshotsDir)];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const schemas: Record<string, unknown>[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const parsed = JSON.parse(await Deno.readTextFile(join(snapshotsDir, entry.name)));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      schemas.push(parsed as Record<string, unknown>);
    }
  }
  return schemas;
}

/**
 * Generates the compatibility manifest for one project: imports the schema
 * module, fingerprints its compiled schema as the head, and fingerprints
 * every committed migration snapshot (`src/migrations/snapshots/*.json`) as
 * the lineage.
 */
export async function generateSchemaCompatManifest(options: {
  /** The build revision (source hash) this manifest belongs to. */
  revision: string;
  /** Project root; defaults to the current working directory. */
  root?: string;
}): Promise<SchemaCompatManifest> {
  const root = resolve(options.root ?? Deno.cwd());
  const schemaPath = join(root, "src", "schema.ts");
  let moduleExports: Record<string, unknown>;
  try {
    moduleExports = await import(pathToFileURL(schemaPath).href) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `failed to load ${schemaPath} for the schema compatibility manifest: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const app = findSchemaAppExport(moduleExports);
  // Resolve eagerly so a malformed app fails here with the module named.
  resolveAppWasmSchema(app);
  const ancestors = await readSnapshotSchemas(join(root, "src", "migrations", "snapshots"));
  const range = await buildSchemaVersionRange(app, ancestors);
  return { v: 1, revision: options.revision, head: range.head, lineage: range.lineage };
}
