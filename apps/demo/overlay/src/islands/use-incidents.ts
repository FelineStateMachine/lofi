import { useCallback, useEffect, useState } from "preact/hooks";
import type { RowOf, WriteHandle } from "@nzip/lofi";
import { useLiveQuery, useWrite } from "@nzip/lofi/preact";
import { s } from "@nzip/lofi/schema";
import { app } from "../app.ts";

/**
 * Author-owned domain module. Tables are the nouns of the app; verbs are what
 * happens to them. This module declares two verbs over the `incidents` table,
 * `reportIncident` with effects that run when the write's sync fate settles
 * and `setIncidentStatus` as a plain verb, then wraps them in a domain hook.
 */
const incidentsTable = app.schema.incidents;

/** The row type comes straight from the declared schema. */
export type Incident = RowOf<typeof incidentsTable>;

export type Severity = Incident["severity"];
export type IncidentStatus = Incident["status"];

/** A one-line consequence or compensation surfaced to the UI. */
export type IncidentNotice = { kind: "synced" | "rejected"; text: string };

// A tiny author-owned notice channel: effect handlers run outside any
// component, so they publish through module state and hooks subscribe.
let notice: IncidentNotice | null = null;
const noticeListeners = new Set<() => void>();

function publishNotice(next: IncidentNotice | null): void {
  notice = next;
  for (const listener of [...noticeListeners]) listener();
}

/**
 * The reporting verb. Its effect units are declared once, here: the
 * consequence runs when the store confirms the row, the compensation runs if
 * a stale-policy write is denied, even if the app restarted in between.
 */
export const reportIncident = s.mutation("reportIncident", s.insert(incidentsTable), {
  effects: [s.log("incident-reported")],
  onSynced: (incident) => {
    publishNotice({
      kind: "synced",
      text: `"${incident.title ?? "Incident"}" confirmed by the store`,
    });
  },
  onRejected: (incident) => {
    // The engine already rolled the denied row back out of local reads; this
    // compensates what the user was told.
    publishNotice({
      kind: "rejected",
      text: `"${incident.title ?? "Incident"}" was declined by the store and has been removed`,
    });
  },
});

/** Moving an incident between states is a plain verb: same lifecycle. */
export const setIncidentStatus = s.mutation("setIncidentStatus", s.update(incidentsTable));

/** Subscribes to the latest effect notice; `null` until one is published. */
export function useIncidentNotice(): IncidentNotice | null {
  const [current, setCurrent] = useState<IncidentNotice | null>(notice);
  useEffect(() => {
    const listener = () => setCurrent(notice);
    noticeListeners.add(listener);
    listener();
    return () => void noticeListeners.delete(listener);
  }, []);
  return current;
}

export function useIncidents() {
  const query = useLiveQuery(() => incidentsTable.orderBy("openedAt", "desc"), []);
  const [lastWrite, setLastWrite] = useState<WriteHandle<Incident> | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const write = useWrite(lastWrite);

  const report = useCallback((title: string, severity: Severity) => {
    // The verb returns a WriteHandle: awaiting it means saved on this device;
    // `.synced` and the declared effects follow the store's confirmation.
    const handle = reportIncident({
      title,
      severity,
      status: "burning",
      openedAt: new Date(),
    });
    setLastWrite(handle);
    setWriteError(null);
    handle.saved.then(undefined, (error) => {
      setWriteError(error instanceof Error ? error.message : String(error));
    });
    return handle;
  }, []);
  const setStatus = useCallback(
    (id: string, status: IncidentStatus) => setIncidentStatus(id, { status }),
    [],
  );

  const durability = write.stage === "synced"
    ? "global" as const
    : write.stage === "saved" || write.stage === "syncing"
    ? "local" as const
    : write.stage === "rejected"
    ? "failed" as const
    : "none" as const;

  return {
    status: query.status === "error" || writeError !== null ? "error" as const : query.status,
    error: query.error ?? writeError,
    durability,
    lastWriteStage: write.stage,
    lastWriteReason: write.reason,
    incidents: query.rows,
    failureKind: query.status === "error" ? "read" as const : "write" as const,
    report,
    setStatus,
  };
}
