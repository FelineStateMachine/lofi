# M3 physical-device checklist

Status: **implementation ready; physical rows pending**\
Evidence owner: **issues #16, #18, and #19**

This checklist is the manual evidence gate for `DX-DEVICE-01`, `DX-DEVICE-UX-01`, and
`DX-OFFLINE-01`. Desktop automation may prepare and falsify the workflow, but it cannot graduate an
installed mobile PWA, operating-system process termination, storage eviction behavior, or a real
authenticator.

## Origins

- Live HTTPS development: `deno task --tunnel dev`. Keep the Deno Deploy application and its
  `*.deno.net` hostname stable. Only `JAZZ_APP_ID` and `JAZZ_SERVER_URL` belong in its Local
  environment.
- Production PWA evidence: build with `deno task build`, then publish that exact output through nzip
  without changing its stable address.
- Any future WebAuthn ceremony must use `location.hostname` as its RP ID. Do not enroll a credential
  on localhost, an IP address, a disposable tunnel hostname, or a hostname absent from the
  author-owned `referenceApp.credentialOrigins` exact/wildcard list.

## Device matrix

Do not replace pending cells with family names such as “recent iPhone.” Record the exact values
shown by the device and browser.

| Device class | Exact hardware | OS version/build | Browser version | Tab     | Installed | Evidence |
| ------------ | -------------- | ---------------- | --------------- | ------- | --------- | -------- |
| iPhone       | pending        | pending          | Safari pending  | pending | pending   | pending  |
| Android      | pending        | pending          | Chrome pending  | pass    | pass      | partial  |

For each row also record the commit SHA, Deno version, package version, stable origin, whether Jazz
cloud mode was configured, and whether caches were cold or warm.

### Android partial evidence — Deno branch preview

An Android screenshot supplied for commit `7e78bb9` at
`https://lofi-dev--agentm3-mobile-pwa.felinestatemachine.deno.net/` records a normal browser tab
with these device-gate results:

- storage persistence: `not-granted`;
- display mode: `browser`;
- PWA worker: `ready`;
- install: `available`;
- identity: `device-local key`;
- credential origin: `stable`;
- future RP ID: `lofi-dev--agentm3-mobile-pwa.felinestatemachine.deno.net`;
- WebAuthn: `available`;
- PRF client extension: `available`;
- passkey backup: `blocked by alpha security review`.

After selecting **Request storage persistence**, the user reported that storage persistence was
granted on the same Android origin. This confirms that the visible remediation can transition the
device from `not-granted` to granted; retained-data behavior still requires the lifecycle and
offline procedures below.

The user subsequently reported that the PWA installed successfully, an item survived reload, and the
installed app rendered its shell and retained item from an offline cold start. This passes the
Android tab/install, reload-retention, and installed offline cold-start checks for this Deno branch
build.

At exact commit `ab4137c40e2efde77a252a830f313793b4cbc070` on the same stable origin, the user
reported all three Android WebAuthn probe results passing:

- test passkey creation: `created`;
- discoverable test passkey retrieval: `retrieved`;
- synthetic sibling RP guard: `sibling-rejected`.

The ceremony used the deployed application's exact `location.hostname` as its RP ID. This validates
the origin-only probe on a real Android authenticator; it does not graduate passkeys into
application identity, backup, or recovery.

The Android row remains partial. The evidence does not yet identify exact hardware, Android or
Chrome versions, cache temperature, or Jazz mode. Short and five-minute background recovery, process
termination, device restart, and console/network results remain open.

## Per-variant procedure

Run every applicable step once in a normal browser tab and once in the installed app:

1. Open the stable HTTPS origin and capture the device gate. It must report secure context, service
   worker, OPFS, SharedWorker, Web Locks, persistence, WebAuthn, PRF client-extension status,
   display mode, and credential-origin status without exposing configuration values.
2. Create a uniquely named item and wait for local durability. In cloud mode, separately wait for
   global durability before beginning lifecycle interruption.
3. Reload. The item and device-local identity wording must remain.
4. Background for approximately 30 seconds, then foreground. Confirm retained data immediately. In
   cloud mode, make another write and confirm that the lofi lifecycle row records a completed
   foreground reconnect request; it must continue to call live transport state unavailable.
5. Background for at least five minutes, then repeat the foreground write and settlement check.
6. Toggle airplane mode while the app is loaded. Create and reload an offline item. Restore the
   network and, in cloud mode, confirm pending writes settle globally.
7. Terminate the browser/app process. Relaunch from the same origin or installed icon and confirm
   retained data before restoring any network dependency.
8. Restart the device and repeat the relaunch/read check.
9. For the installed production build, launch in airplane mode from a fully terminated state. The
   shell and retained data must render with no network request required for startup.
10. Capture console and network failures. Zero is a recorded result, not an omitted field.

If the browser reports unsupported durable storage, record the exact missing capability and stop the
write test. Do not opt into or imply an automatic memory fallback.

## Lifecycle evidence

The lofi foreground manager observes only BFCache `pageshow`, visible `visibilitychange`, and
`online`. In managed mode it single-flights the supported Jazz `db.reconnect()` call. A completed
call means the reconnect request completed; it does not prove a live WebSocket. Jazz alpha.53 still
exposes no supported socket-owner, leader/follower, or live-connection signal.

Record for every lifecycle step:

- trigger and duration;
- item state before and after;
- local/global durability state;
- lifecycle attempt count, last reason, and action result;
- console/network failures;
- screenshot or remote-inspector log path.

Use Safari Web Inspector over USB for iPhone/iPad and Chrome remote debugging for Android. Retained
evidence must contain no Jazz values, identity material, tokens, response bodies, or device secrets.

## Acceptance boundary

M3 can merge implementation with the matrix visibly pending, but these contracts remain proposed
until the relevant rows pass on physical hardware:

- `DX-DEVICE-UX-01`: Deno Tunnel URL and remediation work on both device classes.
- `DX-OFFLINE-01`: installed production cold-start renders shell and retained data in airplane mode.
- lifecycle recovery: short and five-minute background, process termination, and device restart
  preserve local state; cloud-configured pending writes settle after foreground recovery.
