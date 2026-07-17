# Inbound and outbound Web Share

Use this recipe when a user should explicitly share a small text/link payload through the OS share
sheet or open an installed lofi app with shared text as an uncommitted draft.

The [outbound Web Share API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API) and
inbound
[`share_target` manifest member](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target)
have limited browser support. Both require a secure deployed context; the inbound target appears
only after installation. Unsupported browsers must retain an ordinary copy/link or form flow.

## Outbound share

Import the isolated recipe entrypoint. Call it directly from the click handler so the browser still
has transient user activation:

```tsx
import { shareOrFallback } from "@nzip/lofi/recipes/web-share";

<button
  type="button"
  onClick={() => {
    void shareOrFallback(
      { title: task.text, text: task.text, url: new URL(`#task-${task.id}`, location.href).href },
      {
        fallback: async (data) => {
          await navigator.clipboard.writeText(data.url ?? data.text ?? "");
        },
      },
    ).then((outcome) => {
      // shared: native sheet completed
      // cancelled: user closed the native sheet; do not show an error
      // fallback: the normal copy action ran
      // failed: offer an explicit retry or copy button
      setShareOutcome(outcome);
    });
  }}
>
  Share task
</button>;
```

The helper calls `navigator.canShare()` when present. It falls back only when native sharing is
missing or rejects the payload before opening. Cancellation is a normal result; a runtime failure
does not silently copy data after the native sheet may already have opened.

If Clipboard is also unavailable, make the fallback reveal a normal selected text field or link
instead of claiming that copying succeeded.

## Inbound text/link target

Add an explicit opt-in member to `public/manifest.webmanifest`:

```json
{
  "share_target": {
    "action": "./share/",
    "method": "GET",
    "enctype": "application/x-www-form-urlencoded",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url"
    }
  }
}
```

This recipe intentionally accepts text and HTTP(S) links with GET. POST/file shares require worker
request handling, temporary storage, file validation, and a redirect; lofi does not pretend that the
baseline worker provides those behaviors.

Create `src/pages/share.astro` as a prerendered route:

```astro
---
import ShareReceiver from "../islands/ShareReceiver.tsx";
import Shell from "../layouts/Shell.astro";
---

<Shell title="Review shared content">
  <ShareReceiver client:load />
</Shell>
```

Parse the current query only in the browser. The parser ignores unknown parameters, rejects
duplicates and over-limit values, and accepts only absolute HTTP(S) URLs:

```tsx
import { useEffect, useState } from "preact/hooks";
import { parseTextShareTarget, type TextShareTargetResult } from "@nzip/lofi/recipes/web-share";

export default function ShareReceiver() {
  const [result, setResult] = useState<TextShareTargetResult>();

  useEffect(() => {
    setResult(parseTextShareTarget(location.search));
  }, []);

  if (!result) return <p role="status">Opening shared draft…</p>;
  if (!result.ok) return <p role="alert">This shared content is not valid.</p>;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // Persist result.draft only here, after the user confirms.
      }}
    >
      <h1>Review shared content</h1>
      {result.draft.title && <p>{result.draft.title}</p>}
      {result.draft.text && <p>{result.draft.text}</p>}
      {result.draft.url && <a href={result.draft.url}>{result.draft.url}</a>}
      <button type="submit">Add to app</button>
    </form>
  );
}
```

Change the default parameter names or limits only when the manifest and parser options change
together. Never render a received URL as HTML, use it as an arbitrary redirect, or persist the draft
on page load.

## Build, install, and remove

`deno task doctor` validates the member shape and same-scope action. `deno task build` also requires
the action to map to a prerendered route, which puts that HTML and its assets in the offline shell.

Manifest capability changes do not propagate uniformly across installed platforms. After adding or
removing the target, verify a fresh install and an existing installation; some platforms require
reinstallation before the OS share sheet changes. Removing the member and receiver route restores
the ordinary web app without affecting stored lofi data.

## Verification checklist

1. Open `/share/` directly with no query and show a fixed invalid-draft message.
2. Open it with valid title, text, and HTTP(S) URL values and require confirmation before saving.
3. Reject duplicate, malformed, non-HTTP(S), and over-limit values without echoing them in errors.
4. Install the app, share into it from another app, and verify an offline cold start of the route.
5. Exercise outbound shared, cancelled, unsupported/fallback, and runtime-failed outcomes.
6. Remove `share_target`, rebuild, and confirm the rest of the PWA remains installable and offline.
