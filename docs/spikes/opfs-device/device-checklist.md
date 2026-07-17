# OPFS device checklist

> Framework QA checklist. This is retained with the spike evidence and is not part of the normal
> generated-app onboarding path. Adapt labels and selectors to the current starter before running
> it.

Issue: [#4](https://github.com/FelineStateMachine/lofi/issues/4)\
Build: fill from the site's `lofi-build.json`\
Jazz: 2.0.0-alpha.53

Never record environment values, identity secrets, or task contents that are sensitive. Use unique
throwaway task labels such as `ios-tab-A-1`.

## Record before testing

| Field                           | Value                                                 |
| ------------------------------- | ----------------------------------------------------- |
| Device model                    |                                                       |
| OS and exact version            |                                                       |
| Browser and exact version       |                                                       |
| Surface                         | browser tab / iOS Home Screen / Android installed app |
| Canonical HTTPS URL             |                                                       |
| Display mode shown by site      |                                                       |
| Secure context                  | pass / fail                                           |
| OPFS                            | pass / fail                                           |
| SharedWorker                    | pass / fail                                           |
| Web Locks                       | pass / fail                                           |
| `navigator.storage.persisted()` | granted / not granted / unavailable / error           |
| After request                   | granted / not granted / unavailable / error           |
| Runtime storage state           | `persistent-driver-open` / failed                     |

If the site says `Durable driver blocked`, stop. Record the missing capability. Never continue under
a memory fallback.

## Durability

Use a new throwaway label for each row. Confirm it appears in the task list and that the status line
reports local durability.

| Test                | Action                                                       | Required result                         | Result |
| ------------------- | ------------------------------------------------------------ | --------------------------------------- | ------ |
| Reload              | Add task, reload page                                        | Task returns                            |        |
| Browser termination | Add task, terminate browser from app switcher, reopen URL    | Task returns                            |        |
| App termination     | Installed surface: add task, terminate installed app, reopen | Task returns                            |        |
| Device restart      | Add task, restart device, reopen same surface                | Task returns                            |        |
| Background          | Add task, background 5+ minutes, foreground                  | Task remains; app becomes reactive      |        |
| Offline foreground  | Load once, airplane mode, reopen installed surface, add task | Shell and local write work              |        |
| Reconnect           | Disable airplane mode                                        | Local task remains; no false sync claim |        |

## Multi-tab / multi-window

1. Open the exact canonical URL in tab/window A and B.
2. Confirm both show `persistent-driver-open`.
3. Add `A-<timestamp>` in A; confirm B updates without reload.
4. Add `B-<timestamp>` in B; confirm A updates without reload.
5. Submit once from both surfaces as closely together as possible; confirm both distinct tasks
   appear in both surfaces.
6. Close A; write in B; reopen A and confirm the write.
7. Confirm every live page shows one active client and one underlying subscription locally. Counts
   are per page; the Jazz SharedWorker owns cross-tab leader/follower coordination.

## Installation

### iPhone

1. Run the browser-tab matrix in Safari.
2. Use Share → Add to Home Screen.
3. Open from the icon and verify the site reports `standalone`.
4. Repeat app termination, device restart, offline cold start, and background tests.

### Android

1. Confirm Chrome is version 148 or newer.
2. Run the browser-tab matrix.
3. Install from Chrome's install action.
4. Open from the icon and verify `standalone`.
5. Repeat app termination, device restart, offline cold start, and background tests.

## Decision

- **Graduate current floor:** every required surface passes and reports the persistent driver.
- **Raise platform floor:** failures map to an older browser/OS with a known working newer floor.
- **Degrade safely:** only if lofi adds an explicit user-selected ephemeral mode with a destructive
  warning; never automatic.
- **Evaluate Classic Jazz:** only if its IndexedDB path passes the same matrix and the alpha OPFS
  path does not.
- **Change data layer:** any required current target silently falls back, corrupts, or loses data
  and no honest persistent adapter passes.
