import { useState } from "preact/hooks";
import { settleUiMutation } from "@nzip/lofi";
import {
  type BootProgress,
  Notices,
  useBootProgress,
  usePendingWrites,
  useSyncStatus,
} from "@nzip/lofi/preact";
import {
  type Incident,
  type IncidentStatus,
  type Severity,
  useIncidents,
} from "./use-incidents.ts";

// A cold first visit waits on the engine download, not on storage; name the
// wait it is actually in, with byte progress while the download runs.
function loadingLabel(boot: BootProgress): string {
  if (boot.phase !== "downloading") return "Opening persistent storage…";
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  return boot.totalBytes === null
    ? `Downloading the app · ${mb(boot.loadedBytes)} MB…`
    : `Downloading the app · ${mb(boot.loadedBytes)} of ${mb(boot.totalBytes)} MB…`;
}

const SEVERITIES: readonly Severity[] = ["smolder", "burn", "melt"];

const COLUMNS: readonly { status: IncidentStatus; title: string }[] = [
  { status: "burning", title: "Burning" },
  { status: "contained", title: "Contained" },
  { status: "out", title: "Out" },
];

const MOVES: Record<IncidentStatus, readonly { to: IncidentStatus; label: string }[]> = {
  burning: [{ to: "contained", label: "Contain" }, { to: "out", label: "Extinguish" }],
  contained: [{ to: "out", label: "Extinguish" }, { to: "burning", label: "Flare up" }],
  out: [{ to: "burning", label: "Reignite" }],
};

function openedLabel(value: Incident["openedAt"]): string {
  const opened = value instanceof Date ? value : new Date(String(value));
  return opened.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Author-owned demo UI: one island over one encrypted table, structured as a
 * three-state board. Reporting goes through a verb with effects; moving an
 * incident between states goes through a plain verb; every row carries its
 * real sync fate.
 */
export default function IncidentBoard() {
  const { status, error, durability, incidents, failureKind, report, setStatus } = useIncidents();
  const pending = usePendingWrites();
  const boot = useBootProgress();
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<Severity>("burn");

  return (
    <section id="incidents" class="board" data-island="incidents">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = title.trim();
          if (!next) return;
          setTitle("");
          // The verb's handle is thenable: settled here at saved, while the
          // sync fate and its effects continue in the background.
          void settleUiMutation(report(next, severity));
        }}
      >
        <label for="new-incident">New incident</label>
        <div class="composer">
          <input
            id="new-incident"
            value={title}
            onInput={(event) => setTitle(event.currentTarget.value)}
            autocomplete="off"
          />
          <select
            name="severity"
            aria-label="Severity"
            value={severity}
            onChange={(event) => setSeverity(event.currentTarget.value as Severity)}
          >
            {SEVERITIES.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
          <button type="submit">Report</button>
        </div>
      </form>
      <p class="state" role="status">
        {status === "loading" && loadingLabel(boot)}
        {status === "error" &&
          `${failureKind === "read" ? "Read failed" : "Write failed"}: ${error}`}
        {status === "ready" && `${incidents.length} incident(s) · ${
          durability === "global"
            ? "confirmed by the store"
            : durability === "local"
            ? "saved on this device"
            : durability === "failed"
            ? "write declined"
            : "ready"
        }`}
      </p>
      {pending.count > 0 && (
        <p class="state" data-pending-writes={pending.count}>
          {pending.count} change{pending.count === 1 ? "" : "s"} waiting to sync
        </p>
      )}
      <Notices label="Incident notifications" />
      <div class="columns">
        {COLUMNS.map((column) => {
          const rows = incidents.filter((incident) => incident.status === column.status);
          return (
            <section key={column.status} class="column" data-status={column.status}>
              <h2>
                {column.title} <span class="count">{rows.length}</span>
              </h2>
              {rows.length === 0
                ? <p class="state column-empty">clear</p>
                : (
                  <ul aria-label={column.title}>
                    {rows.map((incident) => (
                      <IncidentItem key={incident.id} incident={incident} setStatus={setStatus} />
                    ))}
                  </ul>
                )}
            </section>
          );
        })}
      </div>
    </section>
  );
}

function IncidentItem(
  { incident, setStatus }: {
    incident: Incident;
    setStatus: (id: string, status: IncidentStatus) => PromiseLike<unknown>;
  },
) {
  const syncStatus = useSyncStatus(incident);
  return (
    <li class={`incident sev-${incident.severity}`}>
      <div class="incident-head">
        <span class="incident-title">{incident.title}</span>
        <span class="incident-meta">
          {incident.severity} · {openedLabel(incident.openedAt)}
        </span>
      </div>
      <div class="incident-actions">
        {MOVES[incident.status].map((move) => (
          <button
            key={move.to}
            type="button"
            class="move"
            onClick={() => void settleUiMutation(setStatus(incident.id, move.to))}
          >
            {move.label}
          </button>
        ))}
        {syncStatus !== "synced" && (
          <span class="state" data-sync-status={syncStatus}>
            {syncStatus === "waiting" ? "waiting to sync" : "declined"}
          </span>
        )}
      </div>
    </li>
  );
}
