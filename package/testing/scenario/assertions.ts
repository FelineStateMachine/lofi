import { ScenarioError } from "./errors.ts";
import {
  type ConvergeSource,
  convergeSourceOf,
  type ScenarioPeer,
  type ScenarioPeerControls,
  type ScenarioTable,
  type ScenarioTableKey,
} from "./peer.ts";

/** Options accepted by {@link converge} alongside the peers. */
export interface ConvergeOptions<A> {
  /** Tables to compare. Defaults to every table of the app. */
  tables?: readonly ScenarioTableKey<A>[];
  /** Deadline for the peers to reach identical views. Defaults to 20 seconds. */
  timeoutMs?: number;
  /** Interval between comparison rounds. Defaults to 250 milliseconds. */
  pollMs?: number;
  /**
   * How to compare counter-merged columns. `"presence"` (the default) checks
   * only that the row and column exist: a replica that watched a counter's
   * history legitimately reads a different total than a fresh boot of the same
   * account, so value equality across live replicas is not part of the
   * convergence contract. `"value"` opts into strict equality anyway.
   */
  counterColumns?: "presence" | "value";
}

type NormalizedTable = Map<string, string>;

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, function (key, cooked: unknown) {
    const raw: unknown = (this as Record<string, unknown>)[key];
    if (raw instanceof Date) return `date:${raw.getTime()}`;
    if (Array.isArray(cooked)) return cooked;
    if (typeof cooked === "object" && cooked !== null) {
      const record = cooked as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
    }
    return cooked;
  });
}

function normalizeRows(
  rows: readonly Record<string, unknown>[],
  skipColumns: ReadonlySet<string>,
  setColumns: ReadonlySet<string>,
): NormalizedTable {
  const normalized: NormalizedTable = new Map();
  for (const row of rows) {
    const id = String(row.id);
    const shaped: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      if (skipColumns.has(column)) {
        shaped[column] = value === undefined ? "absent" : "present";
      } else if (setColumns.has(column) && Array.isArray(value)) {
        shaped[column] = value.map((element) => stableSerialize(element)).sort();
      } else {
        shaped[column] = value;
      }
    }
    normalized.set(id, stableSerialize(shaped));
  }
  return normalized;
}

function diffTables(
  table: string,
  views: readonly { peer: string; rows: NormalizedTable }[],
): string[] {
  const lines: string[] = [];
  const reference = views[0];
  for (const view of views.slice(1)) {
    for (const [id, serialized] of reference.rows) {
      const other = view.rows.get(id);
      if (other === undefined) {
        lines.push(`${table}: row ${id} present on ${reference.peer}, missing on ${view.peer}`);
      } else if (other !== serialized) {
        lines.push(
          `${table}: row ${id} differs\n  ${reference.peer}: ${serialized}\n  ${view.peer}: ${other}`,
        );
      }
    }
    for (const id of view.rows.keys()) {
      if (!reference.rows.has(id)) {
        lines.push(`${table}: row ${id} present on ${view.peer}, missing on ${reference.peer}`);
      }
    }
  }
  return lines;
}

function isPeer(candidate: unknown): candidate is ScenarioPeerControls {
  return typeof candidate === "object" && candidate !== null &&
    typeof (candidate as ScenarioPeerControls).settle === "function";
}

async function tableRound(
  sources: readonly { name: string; source: Extract<ConvergeSource, { kind: "tables" }> }[],
  tables: readonly string[],
  counterColumns: "presence" | "value" | undefined,
): Promise<string[]> {
  const diff: string[] = [];
  for (const table of tables) {
    const skip = counterColumns === "value"
      ? new Set<string>()
      : sources[0].source.counterColumns(table);
    const sets = sources[0].source.setColumns(table);
    const views = await Promise.all(sources.map(async ({ name, source }) => ({
      peer: name,
      rows: normalizeRows(await source.readTable(table, "global"), skip, sets),
    })));
    diff.push(...diffTables(table, views));
  }
  return diff;
}

async function snapshotRound(
  sources: readonly { name: string; source: Extract<ConvergeSource, { kind: "snapshot" }> }[],
): Promise<string[]> {
  const views = await Promise.all(sources.map(async ({ name, source }) => ({
    peer: name,
    view: stableSerialize(await source.snapshot()),
  })));
  const reference = views[0];
  return views.slice(1)
    .filter((view) => view.view !== reference.view)
    .map((view) =>
      `snapshot differs\n  ${reference.peer}: ${reference.view}\n  ${view.peer}: ${view.view}`
    );
}

/**
 * Assert that all peers converge to identical views. Settles every peer's
 * issued writes, then polls until every peer reads the same state, or fails
 * at the deadline with a per-peer diff. All peers must be online. Headless
 * peers compare their tables row by row; browser peers compare their
 * app-supplied value-free snapshots. Accepts an options object after the
 * peers: `converge(alice, bob, { timeoutMs: 30_000 })`.
 */
export async function converge<A>(
  ...args: readonly (ScenarioPeer<A> | ScenarioPeerControls | ConvergeOptions<A>)[]
): Promise<void> {
  const peers = args.filter(isPeer);
  const options = (args.find((arg) => !isPeer(arg)) ?? {}) as ConvergeOptions<A>;
  if (peers.length < 2) {
    throw new ScenarioError("convergence", "converge needs at least two peers");
  }
  for (const peer of peers) {
    if (peer.isOffline) {
      throw new ScenarioError(
        "convergence",
        `${peer.name} is offline; call ${peer.name}.online() before asserting convergence`,
        { peer: peer.name },
      );
    }
  }
  const resolved = peers.map((peer) => {
    const source = convergeSourceOf(peer);
    if (source === undefined) {
      throw new ScenarioError(
        "convergence",
        `${peer.name} does not expose a converge source`,
        { peer: peer.name },
      );
    }
    return { name: peer.name, source };
  });
  const tableSources = resolved.filter(
    (entry): entry is { name: string; source: Extract<ConvergeSource, { kind: "tables" }> } =>
      entry.source.kind === "tables",
  );
  const snapshotSources = resolved.filter(
    (entry): entry is { name: string; source: Extract<ConvergeSource, { kind: "snapshot" }> } =>
      entry.source.kind === "snapshot",
  );
  if (tableSources.length > 0 && snapshotSources.length > 0) {
    throw new ScenarioError(
      "convergence",
      "cannot converge headless and browser peers against each other",
    );
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  await Promise.all(peers.map((peer) => peer.settle({ timeoutMs })));

  const tables = (options.tables as readonly string[] | undefined) ??
    tableSources[0]?.source.tableKeys ?? [];
  let lastDiff: string[] = [];
  while (true) {
    lastDiff = tableSources.length > 0
      ? await tableRound(tableSources, tables, options.counterColumns)
      : await snapshotRound(snapshotSources);
    if (lastDiff.length === 0) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new ScenarioError(
    "convergence",
    `peers did not converge within ${timeoutMs}ms`,
    { details: lastDiff.join("\n") },
  );
}

/**
 * A reference to one of the app's tables, as the row assertions accept it:
 * any of the app object's own table handles (e.g. `app.documents`) matches.
 */
export type ScenarioTableRef<Row> = { readonly _table: string; readonly _rowType: Row };

function tableFacade<Row>(
  peer: ScenarioPeer<unknown>,
  table: ScenarioTableRef<Row>,
): ScenarioTable<Row, unknown, unknown> {
  const facade = (peer.db as Record<string, ScenarioTable<Row, unknown, unknown>>)[table._table];
  if (facade === undefined) {
    throw new ScenarioError(
      "assertion",
      `table ${table._table} is not part of ${peer.name}'s app`,
      { peer: peer.name },
    );
  }
  return facade;
}

/**
 * Assert that a peer's local view contains the row, optionally matching a
 * subset of its columns.
 */
export async function assertRow<Row>(
  peer: ScenarioPeer<unknown>,
  table: ScenarioTableRef<Row>,
  id: string,
  partial?: Partial<Row>,
): Promise<void> {
  const row = await tableFacade(peer, table).get(id);
  if (row === undefined) {
    throw new ScenarioError(
      "assertion",
      `expected ${peer.name} to see row ${id} in ${table._table}, but it is absent`,
      { peer: peer.name },
    );
  }
  for (const [column, expected] of Object.entries(partial ?? {})) {
    const actual = (row as Record<string, unknown>)[column];
    if (stableSerialize(actual) !== stableSerialize(expected)) {
      throw new ScenarioError(
        "assertion",
        `expected ${table._table} row ${id} on ${peer.name} to have ` +
          `${column} = ${stableSerialize(expected)}, found ${stableSerialize(actual)}`,
        { peer: peer.name },
      );
    }
  }
}

/** Assert that a peer's local view does not contain the row. */
export async function assertNoRow(
  peer: ScenarioPeer<unknown>,
  table: ScenarioTableRef<unknown>,
  id: string,
): Promise<void> {
  const row = await tableFacade(peer, table).get(id);
  if (row !== undefined) {
    throw new ScenarioError(
      "assertion",
      `expected ${peer.name} to no longer see row ${id} in ${table._table}, but it is present`,
      { peer: peer.name },
    );
  }
}

/** Assert the number of rows a peer's local view of a table contains. */
export async function assertRowCount(
  peer: ScenarioPeer<unknown>,
  table: ScenarioTableRef<unknown>,
  expected: number,
): Promise<void> {
  const rows = await tableFacade(peer, table).all();
  if (rows.length !== expected) {
    throw new ScenarioError(
      "assertion",
      `expected ${table._table} on ${peer.name} to hold ${expected} row(s), found ${rows.length}`,
      { peer: peer.name },
    );
  }
}
