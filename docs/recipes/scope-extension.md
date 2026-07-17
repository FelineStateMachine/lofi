# Cross-origin app-window scope

Use this recipe only when one product owns both an installed PWA and a separate HTTPS origin that
should remain inside the installed app window, such as product-owned help or a regional surface.
[`scope_extensions`](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/scope_extensions)
is experimental. It changes window presentation after both origins opt in; it does not join their
security, storage, or service-worker boundaries.

The generated starter stays single-origin and omits this capability.

## Declare the extending origin

Add an exact origin to the primary app's `manifest.webmanifest`:

```json
{
  "id": "https://app.example.com/notes",
  "scope_extensions": [
    { "type": "origin", "origin": "https://help.example.com" }
  ]
}
```

The origin must be HTTPS and contain no credentials, path, query, or fragment. Lofi's manifest
validation rejects malformed, duplicate, and invented entries.

## Publish reciprocal ownership

On `https://help.example.com`, publish this JSON at the exact path
`/.well-known/web-app-origin-association`:

```json
{
  "https://app.example.com/notes": {
    "scope": "/notes/"
  }
}
```

The key is the exact absolute manifest ID, not merely the app origin. The value limits which paths
on the extending origin receive app-window presentation. Generate and verify it at deploy time:

```ts
import {
  createScopeExtension,
  createWebAppOriginAssociation,
  verifyWebAppOriginAssociation,
} from "@nzip/lofi/recipes/scope-extension";

const declaration = createScopeExtension("https://help.example.com");
const expected = {
  manifestId: "https://app.example.com/notes",
  scope: "/notes/",
};
const association = createWebAppOriginAssociation(expected);

// After fetching the deployed JSON in trusted deployment tooling:
if (!verifyWebAppOriginAssociation(deployedJson, expected)) {
  throw new Error("reciprocal scope association is missing");
}
```

Do not fetch the association from application runtime code. A true verification result confirms
deployment configuration only; it is not authentication or authorization.

## Deploy, test, and revoke

Deploy in this order:

1. Publish the association on the extending origin with JSON content type, HTTPS, and no redirect.
2. Fetch that exact well-known URL without credentials and verify the exact manifest ID and scope.
3. Add `scope_extensions` to the primary manifest, then allow browser manifest caches to refresh.
4. Test a fresh install and an existing install on supported and unsupported browsers.

During a partial rollout, unsupported browsers, a missing association, or a failed ownership check,
links continue as ordinary out-of-scope navigation and may open browser UI. Build the feature so
that external navigation is useful. For revocation, first remove the primary manifest declaration
and let installed clients refresh; then remove the remote association.

The primary service worker cannot control or cache the extending origin. Offline navigation there
requires that origin's own offline design. The origins retain separate cookies, storage, passkey
relying-party behavior, Jazz configuration, CSP, CORS, authentication, and authorization. Never use
scope extension as a way to share any of them or to bypass an origin boundary.

Test exact and mismatched manifest IDs, invalid and duplicate origins, path-limited navigation,
ordinary external fallback, partial rollout, revocation, offline navigation, manifest refresh, and
passkey/storage/Jazz isolation before shipping.
