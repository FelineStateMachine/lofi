import type { ReactNode } from "react";
import Link from "@docusaurus/Link";
import Layout from "@theme/Layout";

// The /node homepage: what lofi-node is and where its docs live. Content is
// sourced from the lofi-node README (FelineStateMachine/lofi-node); the
// tutorial, guide, and reference pages under /node/docs are assembled by
// tools/node_docs.ts.

const QUICK_START = [
  ["deno task compile", "one self-contained binary (dist/lofi-node)"],
  ["dist/lofi-node init --port 4802", "ticket-gated by default; --open opts out"],
  ["dist/lofi-node start", "gate URL + node-pairing ticket"],
  ["dist/lofi-node ticket issue --label phone", "app-connect ticket (shown once)"],
] as const;

const CARDS: Array<{ title: string; body: string; to: string; link: string }> = [
  {
    title: "Self-host your first sync node",
    body:
      "Compile the binary, start a ticket-gated node, issue an app ticket, and enroll it in a lofi app.",
    to: "/node/docs/self-host-a-sync-node",
    link: "Start the tutorial",
  },
  {
    title: "Sliceable apps and shared stores",
    body:
      "One store as shared infrastructure: slices, the namespace honesty invariant, and the four store states.",
    to: "/node/docs/sliceable-apps-and-shared-stores",
    link: "Read the guide",
  },
  {
    title: "App-ticket contract",
    body:
      "The lofisync1 format, scopes, revocation semantics, and the store-status preflight — the contract the lofi side implements.",
    to: "/node/docs/app-ticket",
    link: "Read the contract",
  },
  {
    title: "API reference",
    body:
      "createSyncNode, SyncNode, ticket codecs, and the test mesh — generated from the lofi-node sources.",
    to: "/node/api",
    link: "Browse the API",
  },
];

export default function NodeHome(): ReactNode {
  return (
    <Layout
      title="Self-host with lofi-node"
      description="One daemon that self-hosts a lofi app's sync backend: an embedded Jazz sync server, iroh node-to-node transport, and a ticket-based access gate."
    >
      <main className="container margin-vert--lg">
        <div className="row">
          <div className="col col--8 col--offset-2">
            <h1>Own your sync location</h1>
            <p>
              <strong>lofi-node</strong>{" "}
              is the first-class way to self-host the sync backend for lofi apps: one daemon
              embedding a real Jazz sync server, <a href="https://iroh.computer">iroh</a>{" "}
              node-to-node transport, and a ticket-based access gate. Browsers keep speaking Jazz's
              protocol — only the server URL changes, and that URL is{" "}
              <em>user-selected data, not developer configuration</em>: the app stores the ticket
              you issue and syncs where you point it.
            </p>
            <ul>
              <li>
                <strong>A real Jazz sync server</strong>{" "}
                — SQLite-backed, health-checked, usable by any lofi app by URL.
              </li>
              <li>
                <strong>Node-to-node replication over iroh</strong>{" "}
                — two homes converge by ticket: dialed by key, hole-punched, no static IPs, no
                cloud dependency.
              </li>
              <li>
                <strong>Tickets, not accounts</strong>{" "}
                — possession of a <code>lofisync1.</code>{" "}
                app ticket is transport access; a provision-scoped ticket additionally administers
                the store, with the admin secret never leaving the node.
              </li>
              <li>
                <strong>One binary</strong>{" "}
                — <code>deno task compile</code>{" "}
                embeds the prebuilt native matrix and runs on macOS and Linux.
              </li>
            </ul>

            <h2>Quick start</h2>
            <pre>
              <code>
                {QUICK_START.map(([cmd, note]) => `$ ${cmd}\n    # ${note}\n`).join("")}
              </code>
            </pre>
            <p>
              The issued ticket carries <em>location + access</em>; the user pastes it into their
              lofi app, which stores it and uses its URL as the sync server. Enrollment on the app
              side is{" "}
              <Link to="/docs/sync-and-recovery">
                documented with the rest of sync and recovery
              </Link>.
            </p>

            <div className="row margin-top--lg">
              {CARDS.map((card) => (
                <div className="col col--6 margin-bottom--lg" key={card.to}>
                  <div className="card" style={{ height: "100%" }}>
                    <div className="card__header">
                      <h3>{card.title}</h3>
                    </div>
                    <div className="card__body">
                      <p>{card.body}</p>
                    </div>
                    <div className="card__footer">
                      <Link className="button button--secondary button--block" to={card.to}>
                        {card.link}
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <p>
              Full documentation: <Link to="/node/docs">/node/docs</Link> · agents can ingest{" "}
              <Link to="/node/llms.txt" target="_blank">/node/llms.txt</Link> or{" "}
              <Link to="/node/llms-full.txt" target="_blank">/node/llms-full.txt</Link> · source:
              {" "}
              <a href="https://github.com/FelineStateMachine/lofi-node">
                FelineStateMachine/lofi-node
              </a>
            </p>
          </div>
        </div>
      </main>
    </Layout>
  );
}
