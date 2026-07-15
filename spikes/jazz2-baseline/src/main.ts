import { BrowserAuthSecretStore, createDb, type Db, type DbConfig } from "jazz-tools";
import { app } from "../schema.ts";
import "./style.css";

const BUILD_ONLY_APP_ID = "00000000-0000-0000-0000-00000000f153";
const APP_ID = import.meta.env.VITE_JAZZ_APP_ID ?? BUILD_ONLY_APP_ID;
const SERVER_URL = import.meta.env.VITE_JAZZ_SERVER_URL;

type Note = {
  id: string;
  body: string;
  createdAt: Date;
};

type Probe = {
  appId: string;
  serverConfigured: boolean;
  storage: "opfs-requested";
  identity: "local-first-secret";
  ready: boolean;
  activeSubscriptions: number;
  lastDurability: "none" | "local" | "global" | "failed";
};

declare global {
  interface Window {
    __LOFI_JAZZ2_PROBE__?: {
      snapshot(): Probe;
      create(body: string): Promise<string>;
      update(id: string, body: string): Promise<void>;
      awaitGlobal(): Promise<boolean>;
      disconnect(): Promise<void>;
      reconnect(): Promise<void>;
      shutdown(): Promise<void>;
    };
  }
}

function databaseConfig(secret: string): DbConfig {
  return {
    appId: APP_ID,
    ...(SERVER_URL ? { serverUrl: SERVER_URL } : {}),
    secret,
    driver: { type: "persistent", dbName: `lofi-jazz2-alpha53-${APP_ID}` },
  };
}

function capabilitySummary(): string {
  const browserNavigator = navigator as Navigator & {
    storage?: { getDirectory?: unknown };
    locks?: { request?: unknown };
  };
  const browserGlobal = globalThis as typeof globalThis & { SharedWorker?: unknown };
  const capabilities = {
    opfs: typeof browserNavigator.storage?.getDirectory === "function",
    sharedWorker: typeof browserGlobal.SharedWorker === "function",
    messageChannel: typeof MessageChannel === "function",
    webLocks: typeof browserNavigator.locks?.request === "function",
  };
  return Object.entries(capabilities)
    .map(([name, available]) => `${name}=${available ? "yes" : "no"}`)
    .join(", ");
}

function renderShell(root: HTMLElement) {
  root.innerHTML = `
    <header>
      <p class="eyebrow">Exact vendor control</p>
      <h1>Jazz 2.0.0-alpha.53</h1>
      <p>This intentionally thin app measures the package without a lofi abstraction.</p>
    </header>
    <dl class="status">
      <div><dt>Storage</dt><dd id="storage-state">persistent/OPFS requested</dd></div>
      <div><dt>Identity</dt><dd>local-first secret</dd></div>
      <div><dt>Sync</dt><dd id="sync-state">${
    SERVER_URL ? "configured" : "not configured"
  }</dd></div>
      <div><dt>Capabilities</dt><dd id="capabilities"></dd></div>
      <div><dt>Last write</dt><dd id="durability-state">none</dd></div>
    </dl>
    <form id="note-form">
      <label for="note-body">Retained note</label>
      <div class="composer">
        <input id="note-body" name="body" autocomplete="off" required />
        <button type="submit">Add locally</button>
      </div>
    </form>
    <p id="message" role="status">Opening the durable database…</p>
    <ul id="notes" aria-label="Retained notes"></ul>
  `;
  const capabilities = root.querySelector<HTMLElement>("#capabilities");
  if (capabilities) capabilities.textContent = capabilitySummary();
}

function renderNotes(root: HTMLElement, notes: Note[]) {
  const list = root.querySelector<HTMLUListElement>("#notes");
  if (!list) return;
  list.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement("li");
      item.dataset.noteId = note.id;
      item.textContent = note.body;
      return item;
    }),
  );
}

function setText(root: HTMLElement, selector: string, text: string) {
  const element = root.querySelector<HTMLElement>(selector);
  if (element) element.textContent = text;
}

async function boot() {
  const root = document.querySelector<HTMLElement>("#app");
  if (!root) throw new Error("The #app mount point is missing.");
  const mount = root;
  renderShell(mount);

  const secret = await BrowserAuthSecretStore.getOrCreateSecret({ appId: APP_ID });
  let db: Db;
  try {
    db = await createDb(databaseConfig(secret));
    setText(mount, "#storage-state", "persistent/OPFS driver opened");
  } catch (error) {
    setText(mount, "#storage-state", "unsupported");
    setText(
      mount,
      "#message",
      `Durable storage failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }

  let activeSubscriptions = 0;
  let lastDurability: Probe["lastDurability"] = "none";
  let lastGlobalConfirmation = Promise.resolve(false);
  const unsubscribe = db.subscribeAll(app.notes, (delta) => {
    renderNotes(mount, delta.all as Note[]);
    setText(mount, "#message", `${delta.all.length} retained note(s)`);
  });
  activeSubscriptions += 1;

  async function createNote(body: string): Promise<string> {
    const write = db.insert(app.notes, { body, createdAt: new Date() });
    lastDurability = "none";
    setText(mount, "#durability-state", "local write visible; confirming OPFS…");
    try {
      const retained = await write.wait({ tier: "local" });
      lastDurability = "local";
      setText(mount, "#durability-state", "confirmed local");
      if (SERVER_URL) {
        lastGlobalConfirmation = write.wait({ tier: "global" }).then(
          () => {
            lastDurability = "global";
            setText(mount, "#durability-state", "confirmed global");
            setText(mount, "#sync-state", "global write confirmed");
            return true;
          },
          (error) => {
            setText(
              mount,
              "#sync-state",
              `global confirmation failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return false;
          },
        );
      }
      return retained.id;
    } catch (error) {
      lastDurability = "failed";
      setText(
        mount,
        "#durability-state",
        `failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async function updateNote(id: string, body: string): Promise<void> {
    const write = db.update(app.notes, id, { body });
    setText(mount, "#durability-state", "update visible; confirming OPFS…");
    await write.wait({ tier: "local" });
    lastDurability = "local";
    setText(mount, "#durability-state", "update confirmed local");
  }

  const form = mount.querySelector<HTMLFormElement>("#note-form");
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = mount.querySelector<HTMLInputElement>("#note-body");
    const body = input?.value.trim() ?? "";
    if (!body) return;
    if (input) input.value = "";
    void createNote(body);
  });

  (globalThis as typeof globalThis & Window).__LOFI_JAZZ2_PROBE__ = {
    snapshot: () => ({
      appId: APP_ID,
      serverConfigured: Boolean(SERVER_URL),
      storage: "opfs-requested",
      identity: "local-first-secret",
      ready: true,
      activeSubscriptions,
      lastDurability,
    }),
    create: createNote,
    update: updateNote,
    awaitGlobal: () => lastGlobalConfirmation,
    disconnect: async () => {
      await db.disconnect();
      setText(mount, "#sync-state", "manually disconnected");
    },
    reconnect: async () => {
      await db.reconnect();
      setText(mount, "#sync-state", "reconnected (transport signal unavailable)");
    },
    shutdown: async () => {
      unsubscribe();
      activeSubscriptions -= 1;
      await db.shutdown();
    },
  };
}

void boot();
