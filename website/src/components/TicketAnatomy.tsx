import type { ReactNode } from "react";
import { useState } from "react";

// An app-connect ticket, opened up. The string is opaque base64url on the
// wire; here the decoded payload is the interface: pick a field, read what
// it does, flip the scope and watch who holds the admin secret.

type FieldKey = "v" | "appId" | "url" | "secret" | "scope" | "label";

const EXPLAIN: Record<FieldKey, { title: string; body: string }> = {
  v: {
    title: "Format version",
    body:
      "Version 1. Parsers treat unknown optional fields as forward-compatible additions, and reject unknown scopes outright rather than granting less than the ticket claims.",
  },
  appId: {
    title: "The store's app id",
    body:
      "Which Jazz app this node hosts. The enrolling app adopts it, unless the deployment pinned its own managed app; a foreign ticket is then refused.",
  },
  url: {
    title: "The gate, verbatim",
    body:
      "Used unchanged as the app's sync server. Jazz clients preserve a base path in the server URL, which is the whole trick that makes the next field work.",
  },
  secret: {
    title: "256-bit secret, riding the path",
    body:
      "Every request the app ever makes (sync WebSockets, catalogue reads) carries it with zero client changes. The node stores only a digest; the string is displayable once.",
  },
  scope: {
    title: "What possession grants",
    body:
      "sync is transport only. provision is a strict superset: store administration, with the gate injecting the node's admin secret server-side. Possession is the opt-in.",
  },
  label: {
    title: "Your bookkeeping",
    body:
      "Issue one ticket per device or context, label it, and revocation stays scoped: one command, live sockets close with code 4001 within seconds.",
  },
};

export default function TicketAnatomy(): ReactNode {
  const [active, setActive] = useState<FieldKey>("secret");
  const [provision, setProvision] = useState(false);

  const field = (key: FieldKey, rendered: ReactNode) => (
    <button
      type="button"
      className={`ta-field ${active === key ? "is-active" : ""}`}
      onClick={() => setActive(key)}
      aria-pressed={active === key}
    >
      {rendered}
    </button>
  );

  return (
    <div className="ta">
      <p className="ta-wire" aria-hidden="true">
        <span className="ta-prefix">lofisync1.</span>
        <span className="ta-blob">
          eyJ2IjoxLCJhcHBJZCI6ImNmZTUyZTQ0LTdhNTktNDIzMi04ZGJi…
        </span>
        <span className="ta-open">⌄ decoded</span>
      </p>

      <div className="ta-body">
        <pre className="ta-json"><code>{"{\n  "}{field("v", <>{'"v"'}: 1</>)}
          {",\n  "}
          {field("appId", <>{'"appId"'}: "cfe52e44-7a59-4232-8dbb-bf53f27aeed6"</>)}
          {",\n  "}
          {field(
            "url",
            <>
              {'"url"'}: "http://192.168.1.10:4802/t/
            </>,
          )}
          {field("secret", <span className="ta-secret">Yr3…43 chars…9Qk</span>)}
          {field("url", <>"</>)}
          {",\n  "}
          {field("scope", <>{'"scope"'}: "{provision ? "provision" : "sync"}"</>)}
          {",\n  "}
          {field("label", <>{'"label"'}: "{provision ? "laptop-admin" : "phone"}"</>)}
          {"\n}"}</code></pre>

        <div className="ta-card" aria-live="polite">
          <h3>{EXPLAIN[active].title}</h3>
          <p>{EXPLAIN[active].body}</p>
          {active === "scope" && (
            <>
              <div className="ta-scope" role="group" aria-label="Ticket scope">
                <button
                  type="button"
                  className={!provision ? "is-active" : ""}
                  onClick={() => setProvision(false)}
                >
                  sync
                </button>
                <button
                  type="button"
                  className={provision ? "is-active" : ""}
                  onClick={() => setProvision(true)}
                >
                  provision
                </button>
              </div>
              <p className={`ta-inject ${provision ? "is-on" : ""}`}>
                {provision
                  ? "X-Jazz-Admin-Secret: injected by the gate. The secret never transits the client."
                  : "admin routes answer 401 invalid_ticket, same as an unknown secret. Nothing to enumerate."}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
