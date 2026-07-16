import { schema as s } from "jazz-tools";
import { referenceApp } from "../apps/reference/src/app.ts";
import migration from "../apps/reference/src/migrations/20260715T194947-notes-to-tasks-6c62fec42c35-ff85ac1d97ee.ts";

const SCHEMA_DIR = "apps/reference/src";
const MIGRATIONS_DIR = `${SCHEMA_DIR}/migrations`;
const SNAPSHOTS_DIR = `${MIGRATIONS_DIR}/snapshots`;
const JAZZ_TOOLS = "npm:jazz-tools@2.0.0-alpha.53";

function fail(message: string): never {
  throw new Error(`migration contract: ${message}`);
}

async function jazz(args: string[]): Promise<string> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", JAZZ_TOOLS, ...args, "--schema-dir", SCHEMA_DIR],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const error = new TextDecoder().decode(output.stderr).trim();
    fail(`Jazz CLI failed: ${error || `exit ${output.code}`}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function jazzSnapshot(hash: string): Promise<unknown> {
  const isolatedEnvironment: Record<string, string> = {};
  for (
    const name of [
      "JAZZ_APP_ID",
      "JAZZ_SERVER_URL",
      "JAZZ_ADMIN_SECRET",
      "BACKEND_SECRET",
      "VITE_JAZZ_APP_ID",
      "VITE_JAZZ_SERVER_URL",
      "PUBLIC_JAZZ_APP_ID",
      "PUBLIC_JAZZ_SERVER_URL",
      "NEXT_PUBLIC_JAZZ_APP_ID",
      "NEXT_PUBLIC_JAZZ_SERVER_URL",
      "EXPO_PUBLIC_JAZZ_APP_ID",
      "EXPO_PUBLIC_JAZZ_SERVER_URL",
    ]
  ) isolatedEnvironment[name] = "";
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      JAZZ_TOOLS,
      "schema",
      "export",
      "--schema-hash",
      hash,
      "--migrations-dir",
      MIGRATIONS_DIR,
    ],
    env: isolatedEnvironment,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    const error = new TextDecoder().decode(output.stderr).trim();
    fail(`snapshot ${hash} does not hash to its filename: ${error || `exit ${output.code}`}`);
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

function hashField(source: string, field: "fromHash" | "toHash"): string {
  const match = source.match(new RegExp(`${field}:\\s*["']([0-9a-f]{12})["']`));
  if (!match) fail(`reviewed migration is missing a 12-character ${field}`);
  return match[1];
}

const hashOutput = await jazz(["schema", "hash"]);
const currentHash = hashOutput.match(/Current schema hash:\s*([0-9a-f]{12})/)?.[1];
if (!currentHash) fail(`could not read the current hash from Jazz CLI output: ${hashOutput}`);

const migrationNames: string[] = [];
for await (const entry of Deno.readDir(MIGRATIONS_DIR)) {
  if (entry.isFile && entry.name.endsWith(".ts")) migrationNames.push(entry.name);
}
if (migrationNames.length === 0) fail(`no reviewed migrations found in ${MIGRATIONS_DIR}`);

let currentEdgeFound = false;
for (const name of migrationNames.sort()) {
  const source = await Deno.readTextFile(`${MIGRATIONS_DIR}/${name}`);
  const fromHash = hashField(source, "fromHash");
  const toHash = hashField(source, "toHash");
  if (!name.endsWith(`-${fromHash}-${toHash}.ts`)) {
    fail(`${name} does not encode its declared ${fromHash} -> ${toHash} edge`);
  }
  for (const hash of [fromHash, toHash]) {
    const snapshotNames = [];
    for await (const entry of Deno.readDir(SNAPSHOTS_DIR)) {
      if (entry.isFile && entry.name.endsWith(`-${hash}.json`)) snapshotNames.push(entry.name);
    }
    if (snapshotNames.length !== 1) {
      fail(`${name} requires exactly one ${hash} snapshot; found ${snapshotNames.length}`);
    }
    const snapshot = JSON.parse(
      await Deno.readTextFile(`${SNAPSHOTS_DIR}/${snapshotNames[0]}`),
    );
    if (JSON.stringify(await jazzSnapshot(hash)) !== JSON.stringify(snapshot)) {
      fail(`${snapshotNames[0]} does not round-trip through Jazz's hash loader`);
    }
  }
  if (toHash === currentHash) currentEdgeFound = true;
}
if (!currentEdgeFound) {
  fail(`current schema ${currentHash} has no reviewed incoming migration edge`);
}

const currentSnapshots: string[] = [];
for await (const entry of Deno.readDir(SNAPSHOTS_DIR)) {
  if (entry.isFile && entry.name.endsWith(`-${currentHash}.json`)) {
    currentSnapshots.push(entry.name);
  }
}
if (currentSnapshots.length !== 1) {
  fail(`current schema ${currentHash} must have exactly one snapshot`);
}

const currentSnapshot = JSON.parse(
  await Deno.readTextFile(`${SNAPSHOTS_DIR}/${currentSnapshots[0]}`),
);
if (JSON.stringify(referenceApp.schema.wasmSchema) !== JSON.stringify(currentSnapshot)) {
  fail(`current snapshot ${currentSnapshots[0]} does not match schema.ts`);
}

const previousSnapshotName = [];
for await (const entry of Deno.readDir(SNAPSHOTS_DIR)) {
  if (entry.isFile && entry.name.endsWith("-6c62fec42c35.json")) {
    previousSnapshotName.push(entry.name);
  }
}
if (previousSnapshotName.length !== 1) fail("the M1 source snapshot is missing or ambiguous");
const previousSnapshot = JSON.parse(
  await Deno.readTextFile(`${SNAPSHOTS_DIR}/${previousSnapshotName[0]}`),
);
if (JSON.stringify(s.defineApp(migration.from).wasmSchema) !== JSON.stringify(previousSnapshot)) {
  fail("the reviewed lens source does not match the M1 snapshot");
}
if (JSON.stringify(s.defineApp(migration.to).wasmSchema) !== JSON.stringify(currentSnapshot)) {
  fail("the reviewed lens target does not match the current snapshot");
}

const expectedForward = [{
  table: "tasks",
  renamedFrom: "notes",
  operations: [
    { type: "rename", column: "body", value: "text" },
    { type: "introduce", column: "completed", sqlType: "BOOLEAN", value: false },
  ],
}];
if (JSON.stringify(migration.forward) !== JSON.stringify(expectedForward)) {
  fail("the reviewed lens must rename notes/body and add completed=false");
}

console.log(
  `migration contract: ${migrationNames.length} reviewed edge(s), current schema ${currentHash}`,
);
