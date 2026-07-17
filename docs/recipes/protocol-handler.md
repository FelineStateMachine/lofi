# Custom-protocol collaborative-list links

Use this recipe when a companion tool needs to open one collaborative-list item in an installed PWA.
The manifest surface is
[experimental and not Baseline](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/protocol_handlers),
so every shared item must also have an ordinary HTTPS deep link.

## 1. Declare one custom scheme

The starter registers no protocols. Add one lowercase `web+` scheme and a same-scope, prerendered
handler route:

```json
{
  "protocol_handlers": [
    {
      "protocol": "web+lofi",
      "url": "./open-item/?url=%s"
    }
  ]
}
```

The validator requires exactly one `%s`, as the entire value of one query parameter. It rejects
privileged schemes, duplicate protocols, extra members, fragments, escaped scope, and a handler
route that is missing from the offline production output.

Protocol registration and conflicts are browser- and OS-dependent. A browser may ask the user for
confirmation, another application may remain the default, and manifest changes may require an app
refresh or reinstall. To remove the capability, delete `protocol_handlers`, rebuild, refresh or
reinstall the PWA, and verify the OS association separately.

## 2. Parse identifiers, not a redirect

Use links shaped like:

```text
web+lofi:collaborative-list/list_123/item/item_456
```

On the action route:

```ts
import { parseCollaborativeListProtocolTarget } from "@nzip/lofi/recipes/protocol-handler";

const result = parseCollaborativeListProtocolTarget(location.search, {
  protocol: "web+lofi",
  parameter: "url",
  maxLength: 512,
});

if (result.ok) {
  showItemPreview(result.target.listId, result.target.itemId);
} else {
  showGenericInvalidLink();
}
```

`URLSearchParams` performs the one query decode. The parser rejects remaining percent escapes rather
than decoding a second time. It bounds the decoded URL, requires the exact configured scheme and the
exact `collaborative-list/LIST/item/ITEM` shape, and allow-lists both IDs. It returns identifiers
only; the received URL can never become `location.href`, a router destination, or proof of caller
identity.

Build the fallback HTTPS link from your own origin and the validated identifiers. Unsupported
browsers and devices then open the same item through ordinary navigation.

Test direct HTTPS navigation, a valid protocol launch, wrong schemes, malformed and double-encoded
values, duplicate parameters, oversized input, offline action-route startup, fallback links, handler
conflicts, and removal/reinstallation behavior.
