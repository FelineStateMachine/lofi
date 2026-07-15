# Jazz 2 exact-version control

This spike is intentionally a thin vendor control for GitHub issue #7. It pins
`jazz-tools@2.0.0-alpha.53` at every import, asks for the persistent browser driver, and uses the
vendor Vite plugin/local server without a lofi data abstraction.

```sh
deno task spike:jazz2:dev
deno task spike:jazz2:cloud
deno task spike:jazz2:build
deno task spike:jazz2:preview
```

The UI distinguishes a requested OPFS driver from a locally confirmed write. It calls
`WriteResult.wait({ tier: "local" })` before claiming local durability. “Sync configured” does not
mean “connected”: this package pin has public disconnect/reconnect methods but no public live
connection-state or pending-operation count signal.

The development plugin starts a local Jazz server, injects `VITE_JAZZ_APP_ID` and
`VITE_JAZZ_SERVER_URL`, and writes the generated app ID to this directory's ignored `.env`. The lofi
task runner pre-seeds a stable local app ID in that internal file so Jazz does not trigger a
mid-start Vite restart on the clean first run. The plugin's interactive TTY banner can print its
generated admin secret, so the graduated lofi command must not expose that banner unchanged.

The separate `cloud` task loads the ignored root `.env`, validates the public pair, and maps only
`JAZZ_APP_ID` and `JAZZ_SERVER_URL` into Vite's client-visible namespace. Server credentials remain
unprefixed for the plugin's schema publication and are covered by the repository leak scan.
