# Self-hosting with lofi-node

<!-- Source: FelineStateMachine/lofi-node README.md; site-voice page owned by lofi docs/node/. -->

lofi apps work locally with no server at all, and sync is an election the user makes — so the
natural end of that road is owning the sync location too.
[lofi-node](https://github.com/FelineStateMachine/lofi-node) is the first-class way to do it: one
daemon that embeds a real Jazz sync server, [iroh](https://iroh.computer) node-to-node transport,
and a ticket-based access gate. Browsers keep speaking Jazz's protocol; only the server URL changes,
and that URL is user-selected data the app enrolls at runtime, not configuration a developer
compiled in.

What the node gives you:

- **A real Jazz sync server** — SQLite-backed, health-checked, serving exactly the pinned Jazz
  version your lofi apps run. Any lofi app can use it by URL.
- **Tickets, not accounts.** A `lofisync1.` app-connect ticket carries location and access in one
  string; possession is transport access, revocation is one command. A provision-scoped ticket
  additionally administers the store, with the admin secret never leaving the node.
- **Node-to-node replication over iroh.** Two homes converge by pairing tickets: dialed by public
  key, hole-punched, no static IPs, no cloud dependency.
- **No silent degradation.** If the native transport layer can't load, the Jazz server still runs
  LAN-only and `status()` says exactly why pairing is off.

## Where to go

- Never run a node before? Start with [Self-host your first sync node](self-host-a-sync-node.md).
- Two locations that should hold the same data: [Pair two homes](pair-two-homes.md).
- Setting up the store an app syncs into — including a second app joining a store that already holds
  data: [Provision a store](provision-a-store.md).
- The mental model behind all of it — slices, shared stores, and why apps can't clobber each other:
  [Sliceable apps and shared stores](sliceable-apps-and-shared-stores.md).

The app-side enrollment flow (pasting a ticket into a lofi app) is part of the framework docs:
[Sync and recovery](/docs/sync-and-recovery).
