import type { ReactNode } from "react";
import { useState } from "react";

// The /node hero explainer: a node you operate. Each action is one real step
// of the lofi-node lifecycle (init → start → ticket → enroll), then the two
// things worth feeling: revocation closing a live socket, and pairing a
// second home. Pure state + CSS; no network, nothing measured.

type Stage = "fresh" | "inited" | "started" | "ticketed" | "enrolled";

type Line = { kind: "cmd" | "out" | "warn"; text: string };

const TICKET_PREVIEW = "lofisync1.eyJ2IjoxLCJhcHBJZCI6ImNmZTUyZ…";

export default function NodePlayground(): ReactNode {
  const [stage, setStage] = useState<Stage>("fresh");
  const [revoked, setRevoked] = useState(false);
  const [paired, setPaired] = useState(false);
  const [lines, setLines] = useState<Line[]>([
    { kind: "out", text: "a machine of yours: laptop, NAS, corner server" },
  ]);

  const say = (...next: Line[]) =>
    setLines((prev) => [...prev.slice(-5), ...next]);

  const init = () => {
    setStage("inited");
    say(
      { kind: "cmd", text: "lofi-node init --port 4802" },
      { kind: "out", text: "config.json written · ticket-gated by default" },
    );
  };
  const start = () => {
    setStage("started");
    say(
      { kind: "cmd", text: "lofi-node start" },
      { kind: "out", text: "gate :4802 · store binds loopback-only" },
    );
  };
  const issue = () => {
    setStage("ticketed");
    setRevoked(false);
    say(
      { kind: "cmd", text: "lofi-node ticket issue --label phone" },
      { kind: "out", text: `${TICKET_PREVIEW} · shown once` },
    );
  };
  const enroll = () => {
    setStage("enrolled");
    say(
      { kind: "cmd", text: "(on the phone) paste the ticket into the app" },
      { kind: "out", text: "sync elected; existing local data pushes up" },
    );
  };
  const revoke = () => {
    setRevoked(true);
    say(
      { kind: "cmd", text: "lofi-node ticket revoke a1b2c3d4e5f6" },
      {
        kind: "warn",
        text: "live socket closed 4001 · unknown ≡ revoked to probers",
      },
    );
  };
  const pair = () => {
    setPaired(true);
    say(
      { kind: "cmd", text: "lofi-node pair endpoint…  (at the studio)" },
      { kind: "out", text: "upstream elected · tunnel up · rtt 23ms, direct" },
    );
  };
  const reset = () => {
    setStage("fresh");
    setRevoked(false);
    setPaired(false);
    setLines([{
      kind: "out",
      text: "a machine of yours: laptop, NAS, corner server",
    }]);
  };

  const linked = stage === "enrolled" && !revoked;

  return (
    <div
      className="np"
      data-stage={stage}
      data-paired={paired ? "" : undefined}
    >
      <div className="np-scene" aria-hidden="true">
        <div className={`np-device ${stage === "enrolled" ? "is-on" : ""}`}>
          <span className="np-device-glyph">▯</span>
          <span className="np-device-label">phone</span>
          {stage === "enrolled" && (
            <span className={`np-chip ${revoked ? "np-chip--dead" : ""}`}>
              {revoked ? "4001" : "lofisync1…"}
            </span>
          )}
        </div>

        <div
          className={`np-link ${linked ? "is-live" : ""} ${
            revoked ? "is-cut" : ""
          }`}
        />

        <div className={`np-home ${stage !== "fresh" ? "is-on" : ""}`}>
          {stage === "ticketed" && (
            <span className="np-chip np-chip--ticket">lofisync1…</span>
          )}
          <span className="np-home-roof" />
          <div className="np-home-body">
            <span
              className={`np-part np-part--gate ${
                stage !== "fresh" ? "is-on" : ""
              }`}
            >
              gate{stage !== "fresh" && <i className="np-led" />}
            </span>
            <span
              className={`np-part np-part--store ${
                stage !== "inited" && stage !== "fresh" ? "is-on" : ""
              }`}
            >
              store
            </span>
          </div>
          <span className="np-home-label">home</span>
        </div>

        <div className={`np-link np-link--tunnel ${paired ? "is-live" : ""}`}>
          {paired && (
            <span className="np-rtt">
              rtt 23ms
              <br />
              direct
            </span>
          )}
        </div>

        <div className={`np-home np-home--peer ${paired ? "is-on" : ""}`}>
          <span className="np-home-roof" />
          <div className="np-home-body">
            <span className="np-part is-on">store</span>
          </div>
          <span className="np-home-label">studio</span>
        </div>
      </div>

      <div className="np-console" role="log" aria-live="polite">
        {lines.map((line, index) => (
          <p key={`${index}-${line.text}`} data-kind={line.kind}>
            {line.kind === "cmd" ? <b>$</b> : null}
            {line.text}
          </p>
        ))}
      </div>

      <div className="np-actions">
        {stage === "fresh" && (
          <button type="button" className="np-btn np-btn--go" onClick={init}>
            lofi-node init
          </button>
        )}
        {stage === "inited" && (
          <button type="button" className="np-btn np-btn--go" onClick={start}>
            lofi-node start
          </button>
        )}
        {stage === "started" && (
          <button type="button" className="np-btn np-btn--go" onClick={issue}>
            ticket issue --label phone
          </button>
        )}
        {stage === "ticketed" && (
          <button type="button" className="np-btn np-btn--go" onClick={enroll}>
            paste it into the app
          </button>
        )}
        {stage === "enrolled" && !revoked && (
          <button type="button" className="np-btn" onClick={revoke}>
            revoke the ticket
          </button>
        )}
        {stage === "enrolled" && revoked && (
          <button type="button" className="np-btn np-btn--go" onClick={issue}>
            issue a fresh ticket
          </button>
        )}
        {stage === "enrolled" && !paired && (
          <button type="button" className="np-btn" onClick={pair}>
            pair a second home
          </button>
        )}
        {stage !== "fresh" && (
          <button
            type="button"
            className="np-btn np-btn--ghost"
            onClick={reset}
          >
            reset
          </button>
        )}
      </div>
    </div>
  );
}
