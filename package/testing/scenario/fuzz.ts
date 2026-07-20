import { converge } from "./assertions.ts";
import { ScenarioError } from "./errors.ts";
import type { ScenarioApp } from "./headless.ts";
import type { ScenarioTable } from "./peer.ts";
import { runHeadlessScenario, type ScenarioConfig } from "./run.ts";

/** The kinds of operations a fuzz plan is built from. */
export type FuzzOpKind = "insert" | "update" | "remove" | "offline" | "online" | "sync";

/**
 * One step of a fuzz plan. Row-targeting steps reference the insert that
 * created the row by its `ref` — the index of that insert in the plan — since
 * row ids are only assigned when the plan runs.
 */
export type FuzzOp =
  | { kind: "insert"; peer: string; table: string; values: Record<string, unknown>; ref: number }
  | { kind: "update"; peer: string; table: string; ref: number; patch: Record<string, unknown> }
  | { kind: "remove"; peer: string; table: string; ref: number }
  | { kind: "offline"; peer: string }
  | { kind: "online"; peer: string }
  | { kind: "sync" };

/** One column of a table, as the fuzz generator sees it. */
export interface FuzzColumn {
  /** Column name. */
  name: string;
  /** The compiled column type tag, e.g. `"Text"` or `"Integer"`. */
  type: string;
  /** Whether the column accepts null. */
  nullable: boolean;
  /** Whether the column has a declared default and can be omitted on insert. */
  hasDefault: boolean;
  /** The column's merge strategy, when it is not last-write-wins. */
  mergeStrategy?: string;
  /** The referenced table, for foreign-key columns. */
  references?: string;
}

/** Input to the pure fuzz-plan generator. */
export interface FuzzPlanInput {
  /** PRNG seed; the same seed always yields the same plan. */
  seed: number;
  /** Number of operations to generate. */
  steps: number;
  /** Peer names participating in the plan. */
  peers: readonly string[];
  /** Column descriptions per table. */
  tables: { readonly [table: string]: readonly FuzzColumn[] };
  /** Relative op-kind weights; omitted kinds use their defaults. */
  weights?: Partial<Record<FuzzOpKind, number>>;
}

/** A generated fuzz plan: the operations plus what the generator left out. */
export interface FuzzPlan {
  /** The seed the plan was generated from. */
  seed: number;
  /** The operations, in execution order. */
  ops: readonly FuzzOp[];
  /**
   * Tables the generator cannot insert into — e.g. a required foreign-key or
   * merge-strategy column with no default — and therefore skipped entirely.
   */
  skippedTables: readonly string[];
}

const DEFAULT_WEIGHTS: Record<FuzzOpKind, number> = {
  insert: 4,
  update: 4,
  remove: 2,
  offline: 1.5,
  online: 1.5,
  sync: 1,
};

const SCALAR_TYPES = new Set(["Text", "Integer", "Float", "Boolean", "Timestamp"]);
const MAX_OFFLINE_OPS = 6;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scalarValue(random: () => number, type: string, sequence: number): unknown {
  switch (type) {
    case "Text":
      return `v${sequence}-${Math.floor(random() * 1000)}`;
    case "Integer":
      return Math.floor(random() * 100);
    case "Float":
      return Math.floor(random() * 1000) / 10;
    case "Boolean":
      return random() < 0.5;
    case "Timestamp":
      return new Date(1_700_000_000_000 + Math.floor(random() * 1_000_000) * 1000);
    default:
      return null;
  }
}

function insertableColumns(columns: readonly FuzzColumn[]): readonly FuzzColumn[] | undefined {
  const generated: FuzzColumn[] = [];
  for (const column of columns) {
    if (column.name === "id") continue;
    const generatable = SCALAR_TYPES.has(column.type) &&
      column.mergeStrategy === undefined && column.references === undefined;
    if (generatable) {
      generated.push(column);
    } else if (!column.hasDefault && !column.nullable) {
      return undefined;
    }
  }
  return generated;
}

/**
 * Generate a fuzz plan: a deterministic, seed-replayable sequence of inserts,
 * updates, removes, offline windows, and sync barriers across the peers.
 * Updates and removes only target rows their peer has locally created or has
 * observed through a sync barrier; offline windows are bounded; the plan ends
 * with every peer back online.
 */
export function generateFuzzPlan(input: FuzzPlanInput): FuzzPlan {
  const random = mulberry32(input.seed);
  const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const tables: { name: string; columns: readonly FuzzColumn[] }[] = [];
  const skippedTables: string[] = [];
  for (const [name, columns] of Object.entries(input.tables)) {
    const insertable = insertableColumns(columns);
    if (insertable === undefined) skippedTables.push(name);
    else tables.push({ name, columns: insertable });
  }

  const ops: FuzzOp[] = [];
  const inserts: { ref: number; table: string; peer: string }[] = [];
  const barrierKnown = new Set<number>();
  const offlinePeers = new Set<string>();
  const offlineOps = new Map<string, number>();

  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];

  const insertValues = (columns: readonly FuzzColumn[]): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const column of columns) {
      if (column.hasDefault && random() < 0.3) continue;
      if (column.nullable && random() < 0.1) {
        values[column.name] = null;
        continue;
      }
      values[column.name] = scalarValue(random, column.type, ops.length);
    }
    return values;
  };

  const targetsFor = (peer: string, table: string): readonly number[] =>
    inserts
      .filter((entry) =>
        entry.table === table && (entry.peer === peer || barrierKnown.has(entry.ref))
      )
      .map((entry) => entry.ref);

  const kindsAvailable = (): FuzzOpKind[] => {
    const kinds: FuzzOpKind[] = [];
    if (tables.length > 0) kinds.push("insert");
    if (inserts.length > 0) kinds.push("update", "remove");
    if (offlinePeers.size < input.peers.length) kinds.push("offline");
    if (offlinePeers.size > 0) kinds.push("online");
    if (offlinePeers.size === 0 && inserts.length > 0) kinds.push("sync");
    return kinds;
  };

  const weightedKind = (kinds: readonly FuzzOpKind[]): FuzzOpKind => {
    const total = kinds.reduce((sum, kind) => sum + weights[kind], 0);
    let roll = random() * total;
    for (const kind of kinds) {
      roll -= weights[kind];
      if (roll <= 0) return kind;
    }
    return kinds[kinds.length - 1];
  };

  for (let step = 0; step < input.steps; step++) {
    // Close any offline window that has run its course before choosing an op.
    const overdue = input.peers.find((peer) =>
      offlinePeers.has(peer) && (offlineOps.get(peer) ?? 0) >= MAX_OFFLINE_OPS
    );
    if (overdue !== undefined) {
      offlinePeers.delete(overdue);
      offlineOps.delete(overdue);
      ops.push({ kind: "online", peer: overdue });
      continue;
    }

    const kinds = kindsAvailable();
    if (kinds.length === 0) break;
    const kind = weightedKind(kinds);
    for (const peer of offlinePeers) offlineOps.set(peer, (offlineOps.get(peer) ?? 0) + 1);

    if (kind === "insert") {
      const table = pick(tables);
      const peer = pick(input.peers);
      const ref = ops.length;
      ops.push({ kind, peer, table: table.name, values: insertValues(table.columns), ref });
      inserts.push({ ref, table: table.name, peer });
    } else if (kind === "update" || kind === "remove") {
      const peer = pick(input.peers);
      const entry = pick(inserts);
      const targets = targetsFor(peer, entry.table);
      if (targets.length === 0) continue;
      const ref = pick(targets);
      if (kind === "update") {
        const columns = tables.find((table) => table.name === entry.table)?.columns ?? [];
        if (columns.length === 0) continue;
        const column = pick(columns);
        ops.push({
          kind,
          peer,
          table: entry.table,
          ref,
          patch: { [column.name]: scalarValue(random, column.type, ops.length) },
        });
      } else {
        ops.push({ kind, peer, table: entry.table, ref });
      }
    } else if (kind === "offline") {
      const online = input.peers.filter((peer) => !offlinePeers.has(peer));
      const peer = pick(online);
      offlinePeers.add(peer);
      offlineOps.set(peer, 0);
      ops.push({ kind, peer });
    } else if (kind === "online") {
      const peer = pick([...offlinePeers]);
      offlinePeers.delete(peer);
      offlineOps.delete(peer);
      ops.push({ kind, peer });
    } else {
      ops.push({ kind: "sync" });
      for (const entry of inserts) barrierKnown.add(entry.ref);
    }
  }

  for (const peer of input.peers) {
    if (offlinePeers.has(peer)) ops.push({ kind: "online", peer });
  }
  return { seed: input.seed, ops, skippedTables };
}

/** Options for a fuzz scenario, extending the scenario config with fuzz knobs. */
export interface FuzzScenarioOptions<A extends ScenarioApp> extends ScenarioConfig<A> {
  /**
   * PRNG seed. Defaults to the `LOFI_FUZZ_SEED` environment variable when
   * set, otherwise a random seed. The seed in use is always part of any
   * failure, so a failing run can be replayed exactly.
   */
  seed?: number;
  /** Number of operations to generate. Defaults to 40. */
  steps?: number;
  /** Tables to fuzz. Defaults to every table the generator can insert into. */
  tables?: readonly string[];
  /** Relative op-kind weights; omitted kinds use their defaults. */
  weights?: Partial<Record<FuzzOpKind, number>>;
}

function fuzzColumnsOf(
  app: ScenarioApp,
  tables?: readonly string[],
): { [table: string]: readonly FuzzColumn[] } {
  const described: { [table: string]: readonly FuzzColumn[] } = {};
  for (const [name, table] of Object.entries(app.wasmSchema)) {
    if (tables !== undefined && !tables.includes(name)) continue;
    described[name] = table.columns.map((column) => ({
      name: column.name,
      type: column.column_type.type,
      nullable: column.nullable,
      hasDefault: column.default !== undefined,
      mergeStrategy: column.merge_strategy,
      references: column.references,
    }));
  }
  return described;
}

function resolveSeed(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  try {
    const fromEnv = Deno.env.get("LOFI_FUZZ_SEED");
    if (fromEnv !== undefined && fromEnv !== "") return Number(fromEnv) >>> 0;
  } catch {
    // Env permission not granted: fall through to a random seed.
  }
  return Math.floor(Math.random() * 0xFFFFFFFF);
}

/**
 * Run one fuzz scenario: generate a plan, execute it through real peers, and
 * assert convergence — across the participating peers and against a fresh
 * canonical reader. Failures carry the seed and the full op trace.
 */
export async function runFuzzScenario<A extends ScenarioApp>(
  options: FuzzScenarioOptions<A>,
): Promise<void> {
  const seed = resolveSeed(options.seed);
  const plan = generateFuzzPlan({
    seed,
    steps: options.steps ?? 40,
    peers: ["alice", "bob"],
    tables: fuzzColumnsOf(options.app, options.tables),
    weights: options.weights,
  });
  const trace = plan.ops.map((op, index) => `${index}: ${JSON.stringify(op)}`).join("\n");
  const report = `seed ${seed} (replay with LOFI_FUZZ_SEED=${seed})\n${trace}`;

  try {
    await runHeadlessScenario(options, async ({ alice, bob, addPeer }) => {
      const peers = { alice, bob };
      const refToId = new Map<number, string>();
      const facadeFor = (
        peer: typeof alice,
        table: string,
      ): ScenarioTable<Record<string, unknown>, Record<string, unknown>, unknown> =>
        (peer.db as Record<
          string,
          ScenarioTable<Record<string, unknown>, Record<string, unknown>, unknown>
        >)[table];

      for (const op of plan.ops) {
        if (op.kind === "sync") {
          // A mid-plan barrier settles durability so later ops can target
          // rows across peers; it deliberately does not assert convergence,
          // because a live replica that offline-edited a remotely deleted row
          // legitimately diverges until it restarts.
          await Promise.all([alice.settle(), bob.settle()]);
          continue;
        }
        const peer = peers[op.peer as keyof typeof peers];
        if (op.kind === "offline") {
          await peer.offline();
        } else if (op.kind === "online") {
          await peer.online();
        } else if (op.kind === "insert") {
          const row = await facadeFor(peer, op.table).insert(op.values);
          refToId.set(op.ref, String(row.id));
        } else {
          const id = refToId.get(op.ref);
          if (id === undefined) continue;
          // A write against a row another peer already deleted may be
          // rejected at adjudication; that is a legitimate outcome, and the
          // invariant under test is convergence, not per-op success.
          if (op.kind === "update") {
            await facadeFor(peer, op.table).update(id, op.patch).catch(() => undefined);
          } else {
            await facadeFor(peer, op.table).remove(id).catch(() => undefined);
          }
        }
      }

      // Restart both peers before the final comparison: what must converge is
      // the durable, adjudicated state every fresh view agrees on, not the
      // session-lifetime echoes of each live replica.
      await Promise.all([alice.settle(), bob.settle()]);
      await Promise.all([alice.restart(), bob.restart()]);
      const canonical = await addPeer("canonical");
      await converge(alice, bob, canonical);
    });
  } catch (error) {
    if (error instanceof ScenarioError) {
      throw new ScenarioError(error.stage, `fuzz run failed: ${error.message}`, {
        cause: error,
        details: report,
      });
    }
    throw new ScenarioError("body", "fuzz run failed", { cause: error, details: report });
  }
}
