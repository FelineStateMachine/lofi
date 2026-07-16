export const DEVELOPMENT_INSPECTOR_MARKER = "lofi-development-inspector";

export type InspectorSnapshot = {
  identity: {
    state: "device-local key active" | "anonymous" | "external" | "unavailable";
    backup: "recovery phrase" | "local-only" | "unavailable";
  };
  storage: {
    driver: "persistent requested" | "persistent open" | "failed";
    persistence: "granted" | "not granted" | "unavailable" | "error";
    fallback: "none" | "explicit memory" | "unavailable";
  };
  sync: {
    mode: "local-only" | "managed configured";
    transport: "paused by inspector" | "live detail unavailable" | "not configured";
    pendingLocalWrites: number;
    pendingGlobalWrites: number;
    lastWrite: "none" | "local" | "global" | "failed";
  };
  runtime: {
    clients: number;
    consumers: number;
    vendorSubscriptions: number;
    mutationListeners: number;
    mutationErrors: number;
  };
  lifecycle: {
    mode: "local-only" | "managed";
    status: "idle" | "offline-deferred" | "recovering" | "completed" | "failed";
    attempts: number;
    lastReason: "none" | "pageshow" | "visibilitychange" | "online";
    transportDetail: "live detail unavailable" | "not configured";
  };
  multiTab: {
    role: "unavailable" | "leader" | "follower";
    detail: string;
  };
};

export type InspectorAdapter = {
  readSnapshot(): InspectorSnapshot | Promise<InspectorSnapshot>;
  subscribe(listener: () => void): () => void;
  setTransportPaused(paused: boolean): Promise<void>;
  restartClient(): Promise<void>;
  clearLocalReplica(): Promise<void>;
};

export type InspectorRow = {
  label: string;
  value: string;
};

export function inspectorRows(snapshot: InspectorSnapshot): InspectorRow[] {
  return [
    { label: "Identity", value: snapshot.identity.state },
    { label: "Auth backup", value: snapshot.identity.backup },
    { label: "Storage driver", value: snapshot.storage.driver },
    { label: "Persistence", value: snapshot.storage.persistence },
    { label: "Storage fallback", value: snapshot.storage.fallback },
    { label: "Sync mode", value: snapshot.sync.mode },
    { label: "Transport", value: snapshot.sync.transport },
    { label: "Pending lofi local", value: String(snapshot.sync.pendingLocalWrites) },
    { label: "Pending lofi global", value: String(snapshot.sync.pendingGlobalWrites) },
    { label: "Last write", value: snapshot.sync.lastWrite },
    { label: "Clients", value: String(snapshot.runtime.clients) },
    { label: "Consumers", value: String(snapshot.runtime.consumers) },
    { label: "Vendor subscriptions", value: String(snapshot.runtime.vendorSubscriptions) },
    { label: "Mutation listeners", value: String(snapshot.runtime.mutationListeners) },
    { label: "Mutation errors", value: String(snapshot.runtime.mutationErrors) },
    { label: "Lifecycle mode", value: snapshot.lifecycle.mode },
    { label: "Lifecycle action", value: snapshot.lifecycle.status },
    { label: "Lifecycle attempts", value: String(snapshot.lifecycle.attempts) },
    { label: "Lifecycle reason", value: snapshot.lifecycle.lastReason },
    { label: "Lifecycle transport", value: snapshot.lifecycle.transportDetail },
    { label: "Multi-tab role", value: snapshot.multiTab.role },
    { label: "Multi-tab detail", value: snapshot.multiTab.detail },
  ];
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  name: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountInspector(
  adapter: InspectorAdapter,
  options: { document?: Document } = {},
): { element: HTMLElement; dispose(): void } {
  const document = options.document ?? globalThis.document;
  if (!document?.body) {
    throw new Error("lofi inspector requires a browser document body");
  }

  const host = element(document, "aside");
  host.dataset.lofiInspector = DEVELOPMENT_INSPECTOR_MARKER;
  host.setAttribute("aria-label", "lofi developer inspector");
  const shadow = host.attachShadow({ mode: "open" });
  const style = element(document, "style");
  style.textContent = `
    :host { all: initial; color: #ecf7f1; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    section { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: min(390px, calc(100vw - 24px)); max-height: min(660px, calc(100vh - 24px)); overflow: auto; border: 1px solid #587066; border-radius: 10px; background: #101b17f2; box-shadow: 0 18px 54px #0008; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; position: sticky; top: 0; background: #101b17; }
    h2 { font: 700 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }
    button { border: 1px solid #6f8d80; border-radius: 6px; color: inherit; background: #1b3028; padding: 6px 8px; font: inherit; cursor: pointer; }
    button:disabled { cursor: wait; opacity: .55; }
    [data-body][hidden] { display: none; }
    dl { display: grid; grid-template-columns: minmax(120px, .8fr) minmax(0, 1.2fr); margin: 0; padding: 0 12px 10px; }
    dt, dd { border-top: 1px solid #ffffff18; margin: 0; padding: 5px 0; overflow-wrap: anywhere; }
    dt { color: #a8c3b7; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 12px; }
    [role=status] { color: #f0c47c; min-height: 1.4em; margin: 0; padding: 0 12px 10px; }
  `;
  const panel = element(document, "section");
  const header = element(document, "header");
  const title = element(document, "h2", "lofi dev inspector");
  const toggle = element(document, "button", "Hide");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "true");
  const body = element(document, "div");
  body.dataset.body = "";
  const list = element(document, "dl");
  const actions = element(document, "div");
  actions.className = "actions";
  const offline = element(document, "button", "Simulate transport offline");
  const restart = element(document, "button", "Restart client");
  const clear = element(document, "button", "Clear local replica");
  const status = element(document, "p");
  status.setAttribute("role", "status");
  for (const button of [offline, restart, clear]) {
    button.type = "button";
    actions.append(button);
  }
  header.append(title, toggle);
  body.append(list, actions, status);
  panel.append(header, body);
  shadow.append(style, panel);
  document.body.append(host);

  let active = true;
  let busy = false;
  let current: InspectorSnapshot | null = null;
  let refreshGeneration = 0;
  const setBusy = (value: boolean) => {
    busy = value;
    for (const button of [offline, restart, clear]) button.disabled = value;
  };
  const render = (snapshot: InspectorSnapshot) => {
    current = snapshot;
    list.replaceChildren();
    for (const row of inspectorRows(snapshot)) {
      list.append(element(document, "dt", row.label), element(document, "dd", row.value));
    }
    offline.textContent = snapshot.sync.transport === "paused by inspector"
      ? "Resume cloud transport"
      : snapshot.sync.mode === "local-only"
      ? "Transport pause unavailable in local-only"
      : "Pause cloud transport";
    offline.disabled = busy || snapshot.sync.mode === "local-only";
  };
  const refresh = async () => {
    const generation = ++refreshGeneration;
    const snapshot = await adapter.readSnapshot();
    if (active && generation === refreshGeneration) render(snapshot);
  };
  const runAction = async (name: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    status.textContent = `${name}…`;
    try {
      await action();
      status.textContent = `${name} complete.`;
      await refresh();
    } catch {
      status.textContent =
        `${name} failed. Run deno task doctor, apply the first action, then retry.`;
    } finally {
      setBusy(false);
    }
  };

  toggle.addEventListener("click", () => {
    body.hidden = !body.hidden;
    toggle.textContent = body.hidden ? "Show" : "Hide";
    toggle.setAttribute("aria-expanded", String(!body.hidden));
  });
  offline.addEventListener("click", () => {
    const nextPaused = current?.sync.transport !== "paused by inspector";
    void runAction(
      nextPaused ? "Cloud transport pause" : "Cloud transport resume",
      () => adapter.setTransportPaused(nextPaused),
    );
  });
  restart.addEventListener("click", () => void runAction("Client restart", adapter.restartClient));
  clear.addEventListener("click", () => {
    const confirmed = globalThis.confirm?.(
      "Clear this development replica? The device-local identity is preserved, but unsynced local data is deleted.",
    ) === true;
    if (confirmed) void runAction("Local replica clear", adapter.clearLocalReplica);
  });

  const unsubscribe = adapter.subscribe(() => void refresh());
  void refresh().catch(() => {
    status.textContent =
      "Inspector snapshot failed. Run deno task doctor, apply the first action, then reload.";
  });
  return {
    element: host,
    dispose() {
      if (!active) return;
      active = false;
      unsubscribe();
      host.remove();
    },
  };
}
