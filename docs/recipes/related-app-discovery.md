# Related-application discovery

Use this recipe only when the product already owns a native or installed-web companion and has
completed that platform's bidirectional verification. The
[`getInstalledRelatedApps()` API](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getInstalledRelatedApps)
is experimental, limited to top-level secure contexts in supporting browsers, and intended here only
to avoid redundant presentation such as a companion-app onboarding banner.

## Manifest and verification

The starter omits both members. Add the verified listing while leaving native preference false:

```json
{
  "prefer_related_applications": false,
  "related_applications": [
    {
      "platform": "play",
      "id": "com.example.companion",
      "url": "https://play.google.com/store/apps/details?id=com.example.companion"
    }
  ]
}
```

Do not invent identifiers. Android requires Digital Asset Links; Windows, cross-scope PWAs, and
other platforms have their own verification mechanisms. Manifest declaration alone is not proof of
ownership. Keep `prefer_related_applications` false or omitted so Chromium retains PWA
installability.

## Presentation-only discovery

```ts
import { discoverRelatedApplications } from "@nzip/lofi/recipes/related-app-discovery";

const discovery = await discoverRelatedApplications({
  allow: [{
    platform: "play",
    id: "com.example.companion",
    url: "https://play.google.com/store/apps/details?id=com.example.companion",
  }],
});

const showCompanionOnboarding = discovery.status !== "installed";
```

Only exact allow-list matches are returned. Browser-supplied versions, unknown apps, and extra
fields are discarded. Unsupported, empty, malformed, embedded-context, and rejected calls all retain
the normal PWA experience. Never use discovery for authentication, authorization, account linking,
feature entitlements, or proof that the current user controls the companion app.

Test unsupported and empty results, exact and mismatched platform IDs/URLs, API rejection, top-level
versus embedded contexts, privacy-safe UI, PWA installability, platform verification updates, and
removing the manifest listing.
