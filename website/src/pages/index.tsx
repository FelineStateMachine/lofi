import type { ReactNode } from "react";
import { useState } from "react";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import useBaseUrl from "@docusaurus/useBaseUrl";
import Layout from "@theme/Layout";
import SyncDemo from "../components/SyncDemo";
import Leaf from "../components/Leaf";

import "../css/landing.css";

const CREATE_CMD = "deno run -A jsr:@nzip/lofi/create my-app";

function CopyCmd(): ReactNode {
  const [label, setLabel] = useState("Copy");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CREATE_CMD);
      setLabel("Copied");
      setTimeout(() => setLabel("Copy"), 1600);
    } catch {
      setLabel("Ctrl+C");
    }
  };
  return (
    <div className="cmd">
      <code>
        <b>$&nbsp;</b>
        {CREATE_CMD}
      </code>
      <button type="button" onClick={copy}>{label}</button>
    </div>
  );
}

const FEATURES: Array<{ title: string; body: ReactNode }> = [
  {
    title: "Local-first data",
    body:
      "The UI reads from durable local storage instead of waiting on the network. Storage failures are surfaced, never silently swapped for memory.",
  },
  {
    title: "Identity from first launch",
    body:
      "Each user begins with a private on-device account, even when the app has no sync service configured.",
  },
  {
    title: "Optional sync and recovery",
    body:
      "Users make that same account portable when you connect managed Jazz sync: a passkey where available, a recovery phrase as the portable fallback.",
  },
  {
    title: "Narrow collaboration templates",
    body: (
      <>
        Private resources, direct shares, and fixed-role groups sit behind a
        small <code className="inline-mono">@nzip/lofi/access</code>{" "}
        API. Raw Jazz permissions stay available as an escape hatch.
      </>
    ),
  },
  {
    title: "Local-first test helpers",
    body:
      "Playwright-backed fixtures cover offline writes, multiple clients, convergence, and readiness — without hand-timed sleeps.",
  },
  {
    title: "Explicit mobile support",
    body:
      "Unsupported browsers get a clear explanation, not a half-working app that risks the user's data.",
  },
];

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const version = siteConfig.customFields?.lofiVersion as string;
  const heroArt = useBaseUrl("/img/lofi-hero-art.webp");

  return (
    <Layout
      title="lofi"
      description="lofi generates installable Deno web apps that open immediately, keep working offline, and sync when users choose. Astro shell, Preact islands, Jazz 2 CRDT sync."
    >
      <main className="landing">
        {/* ===================== HERO: MARK + CLAIM ===================== */}
        <div className="wrap">
          <header>
            <div className="hero-top">
              <h1 className="nmark" aria-label="lofi">
                <span className="lo">lo</span>
                <span className="fi">fi</span>
              </h1>
              <div className="hero-side">
                <p className="eyebrow">
                  <span>local-first meta-framework</span>
                  <span className="pill">v{version} · alpha · MIT</span>
                </p>
              </div>
            </div>
            <div className="hero-main">
              <div>
                <p className="hero-claim">
                  Installable web apps where the network is optional and the
                  user holds the keys.
                </p>
                <CopyCmd />
                <p className="cmd-note">
                  Requires Deno 2.9+. Astro + Preact + Jazz 2, generated.
                </p>
                <div className="cta-row">
                  <Link className="btn btn--primary" to="/docs/getting-started">
                    Read the guide
                  </Link>
                  <Link className="btn" href="https://demo.lofi.host">
                    live demo
                  </Link>
                  <Link
                    className="btn"
                    href="https://github.com/FelineStateMachine/lofi"
                  >
                    source
                  </Link>
                </div>
              </div>
              <div className="hero-art">
                <img
                  src={heroArt}
                  width="900"
                  height="900"
                  fetchPriority="high"
                  alt="A phone containing a growing plant. Its roots run below the soil line inside the device; a dotted line arcs to a second, smaller phone."
                />
              </div>
            </div>
          </header>
        </div>

        {/* ===================== LIFECYCLE ===================== */}
        <div className="wrap">
          <section className="band band--rule">
            <div className="band-head">
              <h2>Open now. Back up later.</h2>
            </div>
            <div className="life">
              <div className="life-step">
                <span className="life-tag">First launch</span>
                <h3>A private account, on the device</h3>
                <p>
                  Every user gets an on-device account at first open, even when
                  the app has no sync service configured at all. Nothing to sign
                  up or waiting.
                </p>
              </div>
              <div className="life-step">
                <span className="life-tag">Every launch after</span>
                <h3>Reads from local storage, not the network</h3>
                <p>
                  The UI reads durable local data instead of waiting on a round
                  trip. When storage fails, lofi surfaces it rather than quietly
                  falling back to memory and risking the data.
                </p>
              </div>
              <div className="life-step">
                <span className="life-tag">If the user wants it</span>
                <h3>The same account, made portable</h3>
                <p>
                  Connect managed Jazz sync and a user can back up the account
                  they already have — recovering it with a passkey where
                  supported, or a 24-word phrase. Data made offline comes along.
                </p>
                <p className="life-cmd">
                  <code className="inline-mono">deno task jazz:provision</code>
                  <br />
                  <span>
                    or scaffold with <code className="inline-mono">--sync</code>
                    {" "}
                    from the start.
                  </span>
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* ===================== DEMO ===================== */}
        <div className="wrap">
          <section className="band band--rule">
            <div className="band-head">
              <p className="eyebrow">at the core of the idea</p>
              <h2>Pull the cable.</h2>
              <p className="lede band-lede">
                This is the starter task app the generator gives you. Turn the
                network off, keep typing on both devices, then turn it back on.
                Edits from both sides survive and every replica converges on
                the same result: same-field collisions resolve last-writer-wins,
                everything else merges cleanly. That is what the CRDT buys you.
                The same starter, restyled, runs installable at{" "}
                <Link href="https://demo.lofi.host">demo.lofi.host</Link>,
                deployed from the latest release.
              </p>
            </div>
            <SyncDemo />
          </section>
        </div>

        {/* ===================== FEATURES ===================== */}
        <div className="wrap">
          <section className="band band--rule">
            <div className="band-head">
              <h2>The parts you would otherwise write yourself.</h2>
            </div>
            <div className="grid-3">
              {FEATURES.map((feature) => (
                <div className="cell" key={feature.title}>
                  <Leaf />
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* ===================== ANATOMY ===================== */}
        <div className="wrap">
          <section className="band band--rule">
            <div className="band-head">
              <h2>
                You own the product.
                <br />
                lofi owns the plumbing.
              </h2>
            </div>
            <div className="anat">
              <pre
                className="tree"
                aria-label="Generated project layout, coloured by ownership"
              ><code>{"my-app/\n├── "}<span className="yours">deno.json</span>{"                    "}<span className="note"># tasks + one pinned version</span>{"\n├── "}<span className="yours">public/</span>{"                      "}<span className="note"># manifest, product icons</span>{"\n├── "}<span className="yours">src/</span>{"\n│   ├── "}<span className="yours"><b>app.ts</b></span>{"                   "}<span className="note"># storage, sync, passkey config</span>{"\n│   ├── "}<span className="yours"><b>schema.ts</b></span>{"                "}<span className="note"># persisted data model</span>{"\n│   ├── "}<span className="yours"><b>permissions.ts</b></span>{"           "}<span className="note"># private, shared, or group</span>{"\n│   ├── "}<span className="yours">islands/</span>{"                 "}<span className="note"># interactive Preact UI</span>{"\n│   ├── "}<span className="yours">layouts/</span>{"                 "}<span className="note"># document shell</span>{"\n│   ├── "}<span className="yours">pages/</span>{"                   "}<span className="note"># Astro routes</span>{"\n│   └── "}<span className="yours">styles/</span>{"                  "}<span className="note"># product styling</span>{"\n├── "}<span className="yours">tests/</span>{"                       "}<span className="note"># local-first journeys</span>{"\n├── "}<span className="note">.lofi/</span>{"                       "}<span className="note"># generated tooling (ignored)</span>{"\n└── "}<span className="note">dist/</span>{"                        "}<span className="note"># production PWA (ignored)</span>{"\n\n"}<span className="theirs">@nzip/lofi</span>{"                       "}<span className="note"># storage, identity, sync, PWA</span></code></pre>
              <div>
                <p>
                  A generated project keeps your source separate from the
                  versioned framework package. Product work stays in the files
                  above; framework behaviour is imported, never copied into your
                  tree. Upgrading the package updates the runtime without a
                  migration through your own source.
                </p>
                <ul className="legend">
                  <li>
                    <span className="swatch swatch--yours" />
                    <span>
                      <b>Yours.</b>{" "}
                      Schema, permissions, config, routes, islands, styles,
                      tests.
                    </span>
                  </li>
                  <li>
                    <span className="swatch swatch--theirs" />
                    <span>
                      <b>lofi's.</b>{" "}
                      Storage, identity, sync, lifecycle, and PWA plumbing —
                      imported from one pinned version.
                    </span>
                  </li>
                  <li>
                    <span className="swatch swatch--gen" />
                    <span>
                      <b>Generated.</b>{" "}
                      Regenerated on demand and git-ignored. Never edit by hand.
                    </span>
                  </li>
                </ul>
                <p className="anat-more">
                  <Link to="/docs/reference/project-layout">
                    See the exact generated-project map →
                  </Link>
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* ===================== STACK + LIMITS ===================== */}
        <div className="wrap" id="stack">
          <section className="band band--rule">
            <div className="two-up">
              <div>
                <div className="band-head band-head--tight">
                  <p className="eyebrow">stack and version policy</p>
                  <h2>Pinned on purpose.</h2>
                </div>
                <p className="dim intro-note">
                  The data layer is an alpha, so every upgrade is reviewed and
                  validated before it reaches a generated project.
                </p>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Layer</th>
                      <th>Choice</th>
                      <th>Pinned at</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Data / sync</td>
                      <td>Jazz 2, CRDTs, OPFS</td>
                      <td className="pin">2.0.0-alpha.53</td>
                    </tr>
                    <tr>
                      <td>UI runtime</td>
                      <td>Preact islands, thin adapter</td>
                      <td className="pin">Preact 10 / Astro 7</td>
                    </tr>
                    <tr>
                      <td>Shell</td>
                      <td>Prerendered Astro, static host</td>
                      <td className="pin">Astro 7</td>
                    </tr>
                    <tr>
                      <td>Toolchain</td>
                      <td>Deno tasks, npm compat</td>
                      <td className="pin">Deno 2.9</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <div className="band-head band-head--tight">
                  <h2>What it isn't, yet.</h2>
                </div>
                <p className="dim intro-note">
                  Built for mobile web apps where offline is a requirement, not
                  a best-effort enhancement. Before you commit:
                </p>
                <ul className="limits">
                  <li>
                    <b>It is an early alpha release.</b>{" "}
                    Expect the surface to move, and do not yet trust it with
                    data you cannot afford to lose.
                  </li>
                  <li>
                    <b>The data layer is Jazz 2 alpha</b>, deliberately pinned
                    to a reviewed version. Five known engine defects at the
                    current pin are each documented in a decision record and
                    covered by an automated canary that fails loudly when a
                    version bump changes the behavior.
                  </li>
                  <li>
                    <b>The sync server reads unencrypted columns.</b>{" "}
                    <Link to="/docs/threat-model">The threat model</Link>{" "}
                    states what the server can and cannot see, and which
                    fields you can seal.
                  </li>
                  <li>
                    <b>Browser floors are real.</b>{" "}
                    Android Chrome 148+ and iOS Safari 16.4+.
                  </li>
                  <li>
                    <b>Recovery is user-controlled.</b>{" "}
                    lofi keeps no recoverable account material on the server, so
                    the phrase has to be kept safe.
                  </li>
                </ul>
              </div>
            </div>
          </section>
        </div>

        {/* ===================== COMMANDS ===================== */}
        <div className="wrap">
          <section className="band band--rule">
            <div className="band-head">
              <h2>Every project, a unified toolset.</h2>
              <p className="dim intro-note">
                Every generated project exposes these as{" "}
                <code className="inline-mono">deno task &lt;name&gt;</code>.
              </p>
            </div>
            <div className="two-up">
              <table className="tbl">
                <caption>Everyday development</caption>
                <tbody>
                  <tr>
                    <td>
                      <code>dev</code>
                    </td>
                    <td>Runs the Astro dev server and prints runtime state.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>doctor</code>
                    </td>
                    <td>
                      Checks readiness without printing config or secrets.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>test</code>
                    </td>
                    <td>Runs the deterministic local-first suite.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>build</code>
                    </td>
                    <td>
                      Creates a static production build in <code>dist/</code>.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>preview</code>
                    </td>
                    <td>Serves the production build locally.</td>
                  </tr>
                </tbody>
              </table>
              <table className="tbl">
                <caption>Sync, schema, deployment</caption>
                <tbody>
                  <tr>
                    <td>
                      <code>jazz:provision</code>
                    </td>
                    <td>
                      Creates a managed Jazz app and configures{" "}
                      <code>.env</code>.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>schema:validate</code>
                      <br />
                      <code>schema:deploy</code>
                    </td>
                    <td>Validates and publishes the Jazz schema.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>migrations:create</code>
                      <br />
                      <code>migrations:push</code>
                    </td>
                    <td>Authors and pushes schema migrations.</td>
                  </tr>
                  <tr>
                    <td>
                      <code>deploy</code>
                      <br />
                      <code>deploy:create</code>
                    </td>
                    <td>Hosts the static build on Deno Deploy.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </Layout>
  );
}
