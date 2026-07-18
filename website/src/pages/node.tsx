import type { ReactNode } from "react";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import NodePlayground from "../components/NodePlayground";
import TicketAnatomy from "../components/TicketAnatomy";
import SliceMerge from "../components/SliceMerge";

import "../css/landing.css";
import "../css/node-landing.css";

// The /node landing: lofi-node's front door. Shares the brand tokens with the
// root landing but none of its furniture. The page is three interactive
// rigs: a node you operate, a ticket you open, and a store two apps share.
// lofi-node is an END USER capability (owning where their data syncs), not a
// way to host a lofi app; the copy keeps that audience.

export default function NodeHome(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const version = siteConfig.customFields?.lofiNodeVersion as string;

  return (
    <Layout
      title="lofi-node"
      description="lofi apps let their users choose where data syncs. lofi-node makes that choice real. One daemon a user runs, with an embedded Jazz sync server, iroh node-to-node transport, and a ticket-based access gate."
    >
      <main className="landing landing--node">
        {/* ===================== HERO: MARK + THE PLAYABLE NODE ===================== */}
        <div className="wrap">
          <header className="node-hero">
            <div className="node-hero-top">
              <h1 className="nmark" aria-label="lofi-node">
                <span className="lo">lo</span>
                <span className="fi">fi</span>
                <span className="dash">-</span>
                <span className="node">node</span>
              </h1>
              <div className="node-hero-side">
                <p className="eyebrow">
                  <span>user-owned sync</span>
                  <span className="pill">v{version} · alpha · MIT</span>
                </p>
                <div className="cta-row">
                  <Link
                    className="btn btn--primary"
                    to="/node/docs/self-host-a-sync-node"
                  >
                    Host your first node
                  </Link>
                  <Link className="btn" to="/node/docs">docs</Link>
                  <Link
                    className="btn"
                    href="https://github.com/FelineStateMachine/lofi-node"
                  >
                    source
                  </Link>
                </div>
              </div>
            </div>
            <NodePlayground />
          </header>
        </div>

        {/* ===================== TICKET ANATOMY ===================== */}
        <div className="wrap">
          <section className="band band--rule">
            <div className="band-head">
              <p className="eyebrow">A singular entry</p>
              <h2>Open the ticket.</h2>
              <p className="lede band-lede">
                No accounts, no OAuth, no server-side user table. A{" "}
                <code className="inline-mono">lofisync1.</code>{" "}
                string carries the store's identity and a bearer secret riding
                the URL path, which is why the app needs zero changes to sync
                somewhere new. Click a field.
              </p>
            </div>
            <TicketAnatomy />
            <p className="dim intro-note">
              The normative spec lives with the node and renders here from the
              pinned source:{" "}
              <Link to="/node/docs/app-ticket">the app-ticket contract</Link>.
              <br />
              Both repos test against the same conformance fixtures, so the
              string above can't drift quietly.
            </p>
          </section>
        </div>

        {/* ===================== SHARED STORE ===================== */}
        <div className="wrap">
          <section className="band band--rule">
            <div className="band-head">
              <p className="eyebrow">many apps, one store, no folklore</p>
              <h2>Apps are tenants. The store is yours.</h2>
              <p className="lede band-lede">
                A user's node can hold several lofi apps' data at once. Each app
                may provision only the tables under its own namespaces;
                everything else, a neighbor's tables{" "}
                <em>and its access rules</em>, rides through byte-for-byte. Run
                the story below; every step of it is a real, conformance-tested
                flow.
              </p>
            </div>
            <SliceMerge />
            <p className="dim intro-note">
              The full model:{" "}
              <Link to="/node/docs/sliceable-apps-and-shared-stores">
                sliceable apps and shared stores
              </Link>{" "}
              and the hands-on version,{" "}
              <Link to="/node/docs/provision-a-store">
                provision a store
              </Link>.
            </p>
          </section>
        </div>

        {/* ===================== HONESTY + PATHS ===================== */}
        <div className="wrap">
          <section className="band band--rule">
            <div className="two-up">
              <div>
                <div className="band-head band-head--tight">
                  <h2>Still curious?</h2>
                </div>
                <ul className="limits">
                  <li>
                    <b>The data plane is Jazz 2 alpha, pinned exactly.</b>{" "}
                    A node must run the same alpha as the apps it serves; bumps
                    are coordinated.
                  </li>
                  <li>
                    <b>Windows runs LAN-only.</b>{" "}
                    A documented native-build gap; the store works, pairing
                    reports itself unavailable instead of degrading silently.
                  </li>
                  <li>
                    <b>Tickets are bearer credentials.</b>{" "}
                    Plain http is for trusted LANs; beyond one, front the gate
                    with TLS.
                  </li>
                  <li>
                    <b>Storage is SQLite or memory</b>, the engine's honest
                    surface today. Replicate the file for off-site durability.
                  </li>
                </ul>
              </div>
              <div>
                <div className="band-head band-head--tight">
                  <h2>Keep going.</h2>
                </div>
                <ul className="node-paths">
                  <li>
                    <b>
                      <Link to="/node/docs/self-host-a-sync-node">
                        Self-host a node
                      </Link>
                    </b>: compile, init, ticket, enroll.
                  </li>
                  <li>
                    <b>
                      <Link to="/node/docs/pair-two-homes">Pair two homes</Link>
                    </b>: hole-punched, no static IPs.
                  </li>
                  <li>
                    <b>
                      <Link to="/node/docs/provision-a-store">
                        Provision a store
                      </Link>
                    </b>: the merge, end to end.
                  </li>
                  <li>
                    <b>
                      <Link to="/node/docs/tickets-explained">
                        Tickets explained
                      </Link>
                    </b>: scopes, revocation, posture.
                  </li>
                  <li>
                    <b>
                      <Link to="/node/docs/cli">CLI</Link> ·{" "}
                      <Link to="/node/docs/configuration">Configuration</Link> ·
                      {" "}
                      <Link to="/node/docs/http-surface">HTTP</Link>
                    </b>: the reference shelf.
                  </li>
                  <li>
                    <b>
                      <Link to="/node/api">API reference</Link>
                    </b>: <code className="inline-mono">createSyncNode</code>
                    {" "}
                    and friends, generated from source.
                  </li>
                  <li>
                    <b>
                      <Link to="/node/llms.txt" target="_blank">
                        /node/llms.txt
                      </Link>
                    </b>: the node corpus for agents, separate from the
                    framework's.
                  </li>
                </ul>
              </div>
            </div>
          </section>
        </div>
      </main>
    </Layout>
  );
}
