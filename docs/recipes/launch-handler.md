# Launch handling and client reuse

Use this recipe when an installed single-window app should focus its existing client and
deliberately route a new launch. The
[`launch_handler` manifest member](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/launch_handler)
and `Window.launchQueue` have limited, experimental browser support. Unsupported browsers retain
their ordinary new-window or existing-window behavior.

Do not use client reuse as an authentication boundary. A target URL is external input even when the
browser obtained it from an installed-app launch.

## Choose a client mode

Add this opt-in member to `public/manifest.webmanifest`:

```json
{
  "launch_handler": {
    "client_mode": ["focus-existing", "auto"]
  }
}
```

The ordered array gives supporting browsers a fallback:

- `focus-existing` focuses an existing app window without navigating it. The app handles the target
  through `launchQueue`; if no client exists, the browser opens one.
- `navigate-existing` focuses and navigates an existing client. Use it only when replacing that
  client's current view is expected.
- `navigate-new` opens another client for every launch.
- `auto` leaves the choice to the browser and is the portable final fallback.

Lofi validates the optional member and rejects unknown or repeated modes. The starter omits it.

## Register the consumer early

Create an island mounted from the root layout so every installed route can receive a queued launch:

```tsx
import { useEffect, useState } from "preact/hooks";
import {
  type InstalledAppLaunchIssue,
  installInstalledAppLaunchConsumer,
} from "@nzip/lofi/recipes/launch-handler";

export default function LaunchRouter() {
  const [supported, setSupported] = useState<boolean>();
  const [issue, setIssue] = useState<InstalledAppLaunchIssue>();

  useEffect(() => {
    const consumer = installInstalledAppLaunchConsumer({
      scope: new URL(import.meta.env.BASE_URL, location.origin),
      onLaunch(target) {
        // target.url is proven same-origin and inside the configured path scope.
        const next = new URL(target.url);
        history.replaceState(null, "", `${next.pathname}${next.search}${next.hash}`);
        dispatchEvent(new PopStateEvent("popstate"));
      },
      onRejected: setIssue,
    });
    setSupported(consumer.supported);
    return consumer.dispose;
  }, []);

  if (supported === false) return null; // ordinary browser launch is the fallback
  if (issue) return <p role="alert">The requested app destination is not valid.</p>;
  return null;
}
```

The browser retains launches until a consumer is registered, but mounting this island from only one
leaf route would miss launches handled elsewhere in the app. The helper allows one active consumer
per queue. A stale development/HMR cleanup cannot overwrite a newer generation, and disposing the
current owner leaves a no-op consumer.

The helper rejects missing or malformed targets, credential-bearing URLs, other origins, and paths
outside the exact configured scope. Rejection reasons contain no received URL. Product routing must
still decide whether the in-scope view exists and whether the current user may see it.

## Install, update, and fallback

Manifest launch behavior may not update immediately on every platform. Test both a fresh install and
an existing installation after changing `client_mode`; some platforms require reinstalling before
the OS launch behavior changes. Removing `launch_handler` restores browser-selected launch behavior
without changing lofi data.

Do not force focus or close duplicate windows in unsupported browsers. Ordinary links, shortcuts,
and direct navigations remain the complete fallback.

## Verification checklist

1. Launch with a valid same-origin URL inside the deployment base and route the existing client.
2. Reject another origin, an out-of-scope path, a credential-bearing URL, and malformed input with a
   fixed message that does not echo the target.
3. Confirm a browser without `launchQueue` follows its ordinary launch behavior without an error.
4. Register a new development generation, dispose the older one, and verify the new consumer remains
   active.
5. Test fresh install, existing install, update, offline launch, and removal of the manifest member.
