/**
 * Package-owned boot preflight of the connected store: the runtime-diagnostics
 * side of {@link readTicketStoreStatus}.
 *
 * Against a store with no deployed schema, the engine's writes hang rather
 * than fail. When boot connects managed sync to a ticket-gated node, the
 * runtime asks that node's metadata-only store-status endpoint and records the
 * answer in runtime diagnostics, so the hanging-write symptom surfaces as a
 * named boot state instead. The preflight never gates boot — local readiness
 * does not wait on it, and every failure or timeout maps to a diagnostic
 * value. Nothing here repairs a store: `no_schema` and a differing head are
 * reported for the user to act on through the provisioning opt-in.
 *
 * @module
 */
import { readTicketStoreStatus, type TicketStoreStatus } from "../schema/store.ts";
import type { ActiveSink } from "./config.ts";
import { isTicketServerUrl } from "./data-sink.ts";

/**
 * The boot store preflight carried in runtime diagnostics.
 *
 * `unchecked` is the documented no-alarm value: the runtime is not connecting
 * managed sync, or the active sink is not a ticket-gated node URL (first-party
 * Jazz servers and open-mode nodes expose no store-status endpoint). The other
 * states relay the node's metadata-only answer verbatim. `no_schema` carries
 * the actionable message — writes against such a store hang until it is
 * provisioned. `deployed` carries the store's newest schema hash so a mismatch
 * with this app's deployment can be judged by a human; nothing is ever
 * auto-repaired from this diagnostic.
 */
export type RuntimeStoreStatus =
  | { state: "unchecked"; reason: "sync-not-connected" | "sink-not-ticket-gated" }
  | { state: "deployed"; headHash: string }
  | { state: "no_schema"; message: string }
  | { state: "store_unavailable" }
  | { state: "ticket_rejected" }
  | { state: "unsupported" };

// Matches the actionable voice of the startup-recovery messages: name the
// consequence, then the one remediation.
const noSchemaMessage =
  "The connected store has no schema deployed for this app, so writes will hang instead of " +
  "syncing. Provision the store (see docs/store-provisioning.md), then reload.";

/** How one boot's store preflight is supplied; tests inject the dependencies. */
export type StoreStatusPreflightOptions = {
  /** Whether this runtime is actually connecting managed sync. */
  connect: boolean;
  /** The sync location in effect, or `null` for a local-only device. */
  sink: Pick<ActiveSink, "serverUrl"> | null;
  /** The metadata-only preflight; defaults to {@link readTicketStoreStatus}. */
  preflight?: (ticketUrl: string) => Promise<TicketStoreStatus>;
  /** How long the preflight may take before the store is reported unreachable. */
  timeoutMs?: number;
};

// The classifier itself maps a failed fetch to store_unavailable; the race
// extends the same meaning to a hung one, so boot diagnostics settle within a
// few seconds even when the node black-holes the request.
async function raceTimeout(
  answer: Promise<TicketStoreStatus>,
  timeoutMs: number,
): Promise<TicketStoreStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<TicketStoreStatus>((resolve) => {
    timer = setTimeout(() => resolve({ state: "store_unavailable" }), timeoutMs);
  });
  try {
    return await Promise.race([
      answer.catch((): TicketStoreStatus => ({ state: "store_unavailable" })),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves the store-status diagnostic for one boot. Never throws and never
 * repairs: a preflight error or timeout resolves to `store_unavailable`, and a
 * non-connecting runtime or non-ticket sink resolves to `unchecked` without
 * touching the network — the caller records the value, nothing more.
 */
export async function resolveStoreStatus(
  options: StoreStatusPreflightOptions,
): Promise<RuntimeStoreStatus> {
  const { connect, sink, preflight = readTicketStoreStatus, timeoutMs = 4000 } = options;
  if (!connect || !sink) return { state: "unchecked", reason: "sync-not-connected" };
  if (!isTicketServerUrl(sink.serverUrl)) {
    return { state: "unchecked", reason: "sink-not-ticket-gated" };
  }
  const answer = await raceTimeout(preflight(sink.serverUrl), timeoutMs);
  switch (answer.state) {
    case "deployed":
      return { state: "deployed", headHash: answer.headHash };
    case "no_schema":
      return { state: "no_schema", message: noSchemaMessage };
    default:
      return { state: answer.state };
  }
}

/** One-line label for diagnostic surfaces (development inspector, DeviceStatus). */
export function describeStoreStatus(status: RuntimeStoreStatus): string {
  switch (status.state) {
    case "unchecked":
      return status.reason === "sink-not-ticket-gated"
        ? "not checked (sink has no status endpoint)"
        : "not checked (sync not connected)";
    case "deployed":
      return `deployed (head ${status.headHash})`;
    case "no_schema":
      return "no schema deployed — provision the store";
    case "store_unavailable":
      return "store unreachable";
    case "ticket_rejected":
      return "ticket rejected";
    case "unsupported":
      return "status endpoint unsupported";
  }
}
