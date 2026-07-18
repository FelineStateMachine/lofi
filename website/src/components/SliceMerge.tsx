import type { ReactNode } from "react";
import { useState } from "react";

// The shared-store story you can run: an empty store (where writes would
// hang), a first app provisioning its slice, a second app merging in beside
// it, and a drifted app being refused. Mirrors the real classifier states.

type Phase = "empty" | "taskapp" | "merged";

export default function SliceMerge(): ReactNode {
  const [phase, setPhase] = useState<Phase>("empty");
  const [driftTried, setDriftTried] = useState(false);

  const status = phase === "empty"
    ? {
      code: "no_schema",
      note: "writes would hang; provision before syncing",
    }
    : phase === "taskapp"
    ? { code: "ok", note: "head h1 · taskapp's slice enforced" }
    : driftTried
    ? {
      code: "schema_drift",
      note: "taskapp__tasks differs; surfaced, never repaired",
    }
    : {
      code: "ok",
      note: "head h2 · both slices enforced, one migration apart",
    };

  return (
    <div className="sm" data-phase={phase}>
      <div className="sm-bar">
        <span className="sm-status" data-code={status.code}>
          <i />
          {status.code}
        </span>
        <span className="sm-note">{status.note}</span>
      </div>

      <div className="sm-shelf" aria-hidden="true">
        {phase === "empty"
          ? <span className="sm-empty">one store · nothing deployed</span>
          : (
            <>
              <div className="sm-slice sm-slice--task">
                <span className="sm-ns">taskapp__</span>
                <span
                  className={`sm-table ${driftTried ? "is-contested" : ""}`}
                >
                  tasks
                </span>
                <span className="sm-table">projects</span>
                <span className="sm-seal">
                  {driftTried
                    ? "the store's copy no longer matches the declaration"
                    : phase === "merged"
                    ? "byte-identical through the merge"
                    : "created by taskapp's provisioning"}
                </span>
              </div>
              {phase === "merged" && (
                <div className="sm-slice sm-slice--notes">
                  <span className="sm-ns">notesapp__</span>
                  <span className="sm-table">notes</span>
                  <span className="sm-seal">
                    added via createTables migration
                  </span>
                </div>
              )}
            </>
          )}
      </div>

      <div className="sm-actions">
        {phase === "empty" && (
          <button
            type="button"
            className="np-btn np-btn--go"
            onClick={() => setPhase("taskapp")}
          >
            taskapp provisions its slice
          </button>
        )}
        {phase === "taskapp" && (
          <button
            type="button"
            className="np-btn np-btn--go"
            onClick={() => setPhase("merged")}
          >
            notesapp joins the occupied store
          </button>
        )}
        {phase === "merged" && !driftTried && (
          <button
            type="button"
            className="np-btn"
            onClick={() => setDriftTried(true)}
          >
            a drifted taskapp variant tries
          </button>
        )}
        {driftTried && (
          <button
            type="button"
            className="np-btn np-btn--ghost"
            onClick={() => setDriftTried(false)}
          >
            back away slowly
          </button>
        )}
        {phase !== "empty" && !driftTried && (
          <button
            type="button"
            className="np-btn np-btn--ghost"
            onClick={() => {
              setPhase("empty");
              setDriftTried(false);
            }}
          >
            reset
          </button>
        )}
      </div>
    </div>
  );
}
