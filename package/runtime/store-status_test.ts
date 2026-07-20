// Package contract tests for the boot store-status diagnostic: when the
// preflight runs at all, how every node answer maps onto the runtime
// diagnostic, and that failures and timeouts degrade to a diagnostic value
// instead of gating or failing boot.
import type { TicketStoreStatus } from "../schema/store.ts";
import { isTicketServerUrl } from "./data-sink.ts";
import {
  describeStoreStatus,
  resolveStoreStatus,
  type RuntimeStoreStatus,
} from "./store-status.ts";
import { assert } from "./test-assert.ts";

const ticketUrl = `http://192.168.1.10:4802/t/${"s".repeat(43)}`;

Deno.test("the diagnostic stays unchecked without managed sync or a ticket-gated sink", async () => {
  let calls = 0;
  const preflight = (): Promise<TicketStoreStatus> => {
    calls += 1;
    return Promise.resolve({ state: "no_schema", appId: "a-app" });
  };
  const notConnected = await resolveStoreStatus({
    connect: false,
    sink: { serverUrl: ticketUrl },
    preflight,
  });
  assert(
    notConnected.state === "unchecked" && notConnected.reason === "sync-not-connected",
    `a non-connecting runtime resolved to ${JSON.stringify(notConnected)}`,
  );
  const localOnly = await resolveStoreStatus({ connect: true, sink: null, preflight });
  assert(
    localOnly.state === "unchecked" && localOnly.reason === "sync-not-connected",
    `a local-only device resolved to ${JSON.stringify(localOnly)}`,
  );
  const firstParty = await resolveStoreStatus({
    connect: true,
    sink: { serverUrl: "https://sync.example.com" },
    preflight,
  });
  assert(
    firstParty.state === "unchecked" && firstParty.reason === "sink-not-ticket-gated",
    `a first-party server sink resolved to ${JSON.stringify(firstParty)}`,
  );
  assert(calls === 0, "an unchecked diagnostic must never touch the network");
});

Deno.test("every preflight answer maps onto the runtime diagnostic", async () => {
  const resolve = (answer: TicketStoreStatus): Promise<RuntimeStoreStatus> =>
    resolveStoreStatus({
      connect: true,
      sink: { serverUrl: ticketUrl },
      preflight: (url) => {
        assert(url === ticketUrl, `the preflight received ${url}`);
        return Promise.resolve(answer);
      },
    });
  const deployed = await resolve({ state: "deployed", appId: "a-app", headHash: "ff85" });
  assert(
    deployed.state === "deployed" && deployed.headHash === "ff85",
    `a deployed store resolved to ${JSON.stringify(deployed)} — the head hash must surface ` +
      "verbatim so drift against this app's deployment stays a human judgement",
  );
  const fresh = await resolve({ state: "no_schema", appId: "a-app" });
  assert(fresh.state === "no_schema", `a schema-less store resolved to ${JSON.stringify(fresh)}`);
  assert(
    fresh.state === "no_schema" && fresh.message.includes("hang") &&
      fresh.message.includes("Provision"),
    "no_schema must carry the actionable message naming the hanging-write consequence and the " +
      "provisioning remediation",
  );
  for (const state of ["store_unavailable", "ticket_rejected", "unsupported"] as const) {
    const mapped = await resolve({ state });
    assert(mapped.state === state, `${state} resolved to ${JSON.stringify(mapped)}`);
  }
});

Deno.test("a hung or failing preflight degrades to store_unavailable", async () => {
  const hung = await resolveStoreStatus({
    connect: true,
    sink: { serverUrl: ticketUrl },
    preflight: () => new Promise<TicketStoreStatus>(() => {}),
    timeoutMs: 20,
  });
  assert(
    hung.state === "store_unavailable",
    `a black-holed preflight resolved to ${JSON.stringify(hung)}`,
  );
  const failed = await resolveStoreStatus({
    connect: true,
    sink: { serverUrl: ticketUrl },
    preflight: () => Promise.reject(new Error("network down")),
  });
  assert(
    failed.state === "store_unavailable",
    `a rejecting preflight resolved to ${JSON.stringify(failed)} instead of a diagnostic value`,
  );
});

Deno.test("only ticket and PoP connect paths count as ticket-gated server URLs", () => {
  assert(isTicketServerUrl(ticketUrl), "a valid ticket URL must be recognized");
  assert(
    isTicketServerUrl(`${ticketUrl}/c/${"c".repeat(43)}`),
    "a valid PoP connect URL must be recognized",
  );
  assert(
    !isTicketServerUrl("https://sync.example.com"),
    "a first-party server URL must not be probed",
  );
  assert(
    !isTicketServerUrl("https://node.example/t/short"),
    "a short secret segment must not be treated as a ticket path",
  );
  assert(
    !isTicketServerUrl(`${ticketUrl}/c/short`),
    "a short connect token must not be treated as a ticket path",
  );
  assert(!isTicketServerUrl("not a url"), "a malformed URL must not be treated as a ticket path");
});

Deno.test("describeStoreStatus gives every state a distinct label", () => {
  const statuses: RuntimeStoreStatus[] = [
    { state: "unchecked", reason: "sync-not-connected" },
    { state: "unchecked", reason: "sink-not-ticket-gated" },
    { state: "deployed", headHash: "ff85" },
    { state: "no_schema", message: "provision" },
    { state: "store_unavailable" },
    { state: "ticket_rejected" },
    { state: "unsupported" },
  ];
  const labels = statuses.map(describeStoreStatus);
  assert(new Set(labels).size === labels.length, `labels collide: ${labels.join(" | ")}`);
  assert(labels[2].includes("ff85"), "the deployed label must show the head hash");
  assert(
    labels[0].startsWith("not checked") && labels[1].startsWith("not checked"),
    "unchecked labels must read as not-a-problem, never as an alarm",
  );
});
