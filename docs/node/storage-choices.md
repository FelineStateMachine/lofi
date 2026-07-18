# Storage choices

<!-- Source: FelineStateMachine/lofi-node docs/hosting-lofi-apps.md ("Storage choice") and
     src/config.ts (StorageConfig). -->

The node's store is where your users' synced data durably lives, and the choice is deliberately
narrow because the underlying engine's honest surface is narrow: jazz-napi supports exactly a SQLite
directory or memory today. The `storage.type` discriminator in `config.json` is the seam future
providers slot into.

## SQLite on a path you choose

```sh
lofi-node init --storage-path /mnt/nas/lofi
```

```jsonc
// config.json
"storage": { "type": "sqlite", "path": "/mnt/nas/lofi" }
```

The path can be any mounted location — a NAS volume, a synced directory, an external disk. It is
probed writable at boot; an unwritable location fails fast by name instead of silently degrading.
Omitting the path keeps the store inside the data directory (`<dataDir>/jazz`).

## Memory

```sh
lofi-node init --memory
```

Everything is ephemeral — useful for tests, demos, and throwaway topologies. A restart is a fresh,
schema-less store: enrolled apps will classify it `no_schema` again and prompt for
[provisioning](provision-a-store.md).

## Off-site durability

For cloud-grade durability without a cloud sync service, replicate the SQLite file: a
Litestream-style continuous replica to S3-compatible storage, or snapshots of the volume the path
lives on. [Pairing a second node](pair-two-homes.md) is the other half of the story — replication at
the Jazz layer rather than the file layer — and the two compose.

One honest caveat: back up the **data directory** alongside the store. `config.json` holds the
node's secrets and app id, and `tickets.json` holds the digests that make issued tickets valid; a
restored store without them is reachable by nobody.
