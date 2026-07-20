// Headless scenario adapter: real `createDb` clients on a memory driver
// syncing through a local Jazz server. `jazz-tools` and `jazz-tools/testing`
// are imported dynamically inside the boot path only — this module is loaded
// by the `./testing` entry under the FFI-free unit-test task, so nothing
// FFI-adjacent may load at import time.
import type { CompiledPermissions } from "jazz-tools";
import { ScenarioError } from "./errors.ts";
import {
  registerConvergeSource,
  type ScenarioDb,
  type ScenarioPeer,
  type ScenarioReadOptions,
  type ScenarioSettleOptions,
} from "./peer.ts";

type JazzTesting = typeof import("jazz-tools/testing");
type JazzRoot = typeof import("jazz-tools");
type Db = Awaited<ReturnType<JazzRoot["createDb"]>>;

/** The app-object shape the headless adapter needs: table handles plus the compiled schema. */
export type ScenarioApp = {
  readonly wasmSchema: {
    readonly [table: string]: {
      readonly columns: readonly {
        readonly name: string;
        readonly nullable: boolean;
        readonly default?: unknown;
        readonly references?: string;
        readonly column_type: { readonly type: string };
        readonly merge_strategy?: string;
      }[];
    };
  };
};

type TableHandle = {
  readonly _table: string;
  where(conditions: Record<string, unknown>): unknown;
};

type WriteWaiter = { wait(options: { tier: "local" | "global" }): Promise<unknown> };

function mergeColumns(
  schema: ScenarioApp["wasmSchema"],
  table: string,
  strategy: string,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const column of schema[table]?.columns ?? []) {
    if (column.merge_strategy === strategy) names.add(column.name);
  }
  return names;
}

async function within<T>(operation: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function fillSecret(fill: number): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(fill)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function tableKeysOf(app: object): readonly string[] {
  return Object.entries(app)
    .filter(([, value]) =>
      typeof value === "object" && value !== null &&
      typeof (value as { _table?: unknown })._table === "string"
    )
    .map(([key]) => key);
}

/** A booted headless scenario: a local Jazz server with a deployed app and peer factory. */
export interface HeadlessScenarioHarness<A> {
  /** Boot a new named peer synced to the harness's server. */
  peer(name: string): Promise<ScenarioPeer<A>>;
  /** Tear down every peer and the server, with bounded waits. */
  stop(): Promise<void>;
}

/**
 * Boot a local Jazz server, deploy the app, and return a peer factory.
 * Requires FFI (the local server is native), so callers live in the
 * scenario test task, never in the unit-test task.
 */
export async function createHeadlessScenarioHarness<A extends ScenarioApp>(
  app: A,
  permissions: CompiledPermissions,
): Promise<HeadlessScenarioHarness<A>> {
  const testing: JazzTesting = await import("jazz-tools/testing");
  const root: JazzRoot = await import("jazz-tools");
  const server = await testing.startLocalJazzServer({ allowLocalFirstAuth: true });
  try {
    await testing.deploy({
      appId: server.appId,
      serverUrl: server.url,
      adminSecret: server.adminSecret,
      schema: app as never,
      permissions,
    });
  } catch (error) {
    await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
    throw new ScenarioError("deploy", "deploying the app schema failed", { cause: error });
  }

  const clients: Db[] = [];
  let nextFill = 1;

  const bootClient = (fill: number): Promise<Db> =>
    root.createDb({
      appId: server.appId,
      serverUrl: server.url,
      secret: fillSecret(fill),
      userBranch: "main",
      driver: { type: "memory" },
    });

  const makePeer = async (name: string): Promise<ScenarioPeer<A>> => {
    const fill = nextFill++;
    let db = await bootClient(fill);
    clients.push(db);
    let offline = false;
    let outstanding: WriteWaiter[] = [];

    const track = (handle: WriteWaiter): void => {
      outstanding.push(handle);
    };

    const readTable = async (
      key: string,
      tier: "local" | "global",
    ): Promise<readonly Record<string, unknown>[]> => {
      const handle = (app as Record<string, unknown>)[key] as TableHandle;
      const rows = await db.all(handle as never, { tier });
      return rows as readonly Record<string, unknown>[];
    };

    const facade: Record<string, unknown> = {};
    for (const key of tableKeysOf(app)) {
      const handle = (app as Record<string, unknown>)[key] as TableHandle;
      // Writes apply to the local view immediately; durability waits are left
      // to settle()/converge because local-tier waits do not resolve while
      // the peer is disconnected, and offline writes must not block.
      // The async wrappers turn the vendor's synchronous write errors (e.g.
      // updating a deleted row) into rejections, so callers can uniformly
      // `.catch` them.
      facade[key] = {
        insert: async (values: Record<string, unknown>) => {
          const result = db.insert(handle as never, values as never);
          track(result);
          return await Promise.resolve(result.value);
        },
        update: async (id: string, patch: Record<string, unknown>) => {
          const result = db.update(handle as never, id, patch as never);
          track(result);
          await Promise.resolve();
        },
        remove: async (id: string) => {
          const result = db.delete(handle as never, id);
          track(result);
          await Promise.resolve();
        },
        all: async (where?: Record<string, unknown>, options?: ScenarioReadOptions) => {
          const query = where === undefined ? handle : handle.where(where);
          return await db.all(query as never, { tier: options?.tier ?? "local" });
        },
        get: async (id: string, options?: ScenarioReadOptions) => {
          const row = await db.one(
            handle.where({ id }) as never,
            { tier: options?.tier ?? "local" },
          );
          return row ?? undefined;
        },
      };
    }

    const peer: ScenarioPeer<A> = {
      name,
      get isOffline() {
        return offline;
      },
      db: facade as ScenarioDb<A>,
      async offline() {
        if (offline) return;
        offline = true;
        await db.disconnect();
      },
      async online() {
        if (!offline) return;
        offline = false;
        await db.reconnect();
      },
      async settle(options?: ScenarioSettleOptions) {
        const timeoutMs = options?.timeoutMs ?? 20_000;
        const pending = outstanding;
        outstanding = [];
        const hint = offline ? ` — ${name} is offline; call ${name}.online() before settling` : "";
        // A rejected write is settled: the sync node adjudicated it. Only the
        // durability wait itself failing (e.g. an offline peer) is an error.
        await within(
          Promise.all(
            pending.map((handle) => handle.wait({ tier: "global" }).catch(() => undefined)),
          ),
          `settle of ${pending.length} write(s) on ${name}${hint}`,
          timeoutMs,
        );
      },
      async restart() {
        outstanding = [];
        await within(db.logout(), `${name} logout`, 5_000).catch(() => undefined);
        const index = clients.indexOf(db);
        if (index !== -1) clients.splice(index, 1);
        db = await bootClient(fill);
        clients.push(db);
        offline = false;
      },
    };

    registerConvergeSource(peer, {
      kind: "tables",
      tableKeys: tableKeysOf(app),
      counterColumns: (table) => mergeColumns(app.wasmSchema, table, "Counter"),
      setColumns: (table) => mergeColumns(app.wasmSchema, table, "GSet"),
      readTable,
    });
    return peer;
  };

  return {
    peer: makePeer,
    async stop() {
      await Promise.allSettled(
        clients.map((client, index) => within(client.logout(), `client ${index} cleanup`, 3_000)),
      );
      await within(server.stop(), "server cleanup", 3_000).catch(() => undefined);
    },
  };
}
