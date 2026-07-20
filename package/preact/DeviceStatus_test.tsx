import { describeCredentialOrigin, describeSyncState } from "./DeviceStatus.tsx";

// The report's contract after the sync-state integrity pass: a reader must be
// able to tell *why* nothing is syncing. Each blocked disposition names its
// cause, and the precedence puts the most specific cause first — an owner
// mismatch explains more than a store answer, a store refusal more than a
// missing sink.
Deno.test("describeSyncState names each blocked disposition first-class", () => {
  const base = {
    syncing: false,
    syncAvailable: false,
    ownerMismatch: false,
    storeState: "unchecked" as const,
    sinkUnopenable: false,
  };
  const cases: [Parameters<typeof describeSyncState>[0], string][] = [
    [{ ...base, ownerMismatch: true, syncing: true }, "another account"],
    [{ ...base, storeState: "no_schema", syncing: true }, "no schema"],
    [{ ...base, storeState: "ticket_rejected", syncing: true }, "ticket no longer accepted"],
    [{ ...base, sinkUnopenable: true }, "unopenable"],
    [{ ...base, syncing: true, syncAvailable: true }, "syncing to your account"],
    [{ ...base, syncAvailable: true }, "not yet backed up"],
    [base, "local-only"],
  ];
  for (const [input, needle] of cases) {
    const verdict = describeSyncState(input);
    if (!verdict.includes(needle)) {
      throw new Error(`disposition lost its cause: ${JSON.stringify(input)} → ${verdict}`);
    }
  }
});

// The owner mismatch outranks every other explanation: transport is suppressed
// because of it, so store-level answers describe a connection that is not
// being attempted.
Deno.test("describeSyncState puts the owner mismatch above store answers", () => {
  const verdict = describeSyncState({
    syncing: true,
    syncAvailable: true,
    ownerMismatch: true,
    storeState: "no_schema",
    sinkUnopenable: false,
  });
  if (!verdict.includes("another account")) {
    throw new Error(`owner mismatch was outranked: ${verdict}`);
  }
});

Deno.test("credential-origin status does not overstate API support", () => {
  const local = describeCredentialOrigin({
    status: "local-only",
    rpId: "localhost",
    action: "use the stable HTTPS origin",
  });
  if (!local.includes("local development only") || !local.includes("localhost")) {
    throw new Error(`local credential origin was overstated: ${local}`);
  }
  const stable = describeCredentialOrigin({
    status: "stable",
    rpId: "demo.lofi.host",
    action: "keep this hostname",
  });
  if (!stable.includes("stable") || !stable.includes("demo.lofi.host")) {
    throw new Error(`stable credential origin lost its hostname: ${stable}`);
  }
});
