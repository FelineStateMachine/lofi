import { parseCollaborativeListProtocolTarget } from "./protocol-handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const options = { protocol: "web+lofi", parameter: "url", maxLength: 256 } as const;

Deno.test("protocol target decodes once into allow-listed identifiers", () => {
  const result = parseCollaborativeListProtocolTarget(
    "?url=web%2Blofi%3Acollaborative-list%2Flist_1%2Fitem%2Fitem-2",
    options,
  );
  assert(result.ok, `valid protocol target failed: ${JSON.stringify(result)}`);
  assert(result.target.listId === "list_1", "list ID drifted");
  assert(result.target.itemId === "item-2", "item ID drifted");

  const encodedTwice = parseCollaborativeListProtocolTarget(
    "?url=web%252Blofi%253Acollaborative-list%252Flist_1%252Fitem%252Fitem-2",
    options,
  );
  assert(!encodedTwice.ok && encodedTwice.issue === "invalid-target", "double encoding passed");
});

Deno.test("protocol target rejects duplicates, extras, length, scheme, and shape without values", () => {
  const cases = [
    ["", "missing-target"],
    ["?url=a&url=b", "duplicate-target"],
    ["?url=a&next=https%3A%2F%2Foutside.invalid", "unexpected-parameter"],
    [`?url=${"a".repeat(257)}`, "target-too-long"],
    ["?url=not-a-url", "invalid-target"],
    ["?url=web%2Bother%3Acollaborative-list%2Flist%2Fitem%2Fitem", "wrong-protocol"],
    ["?url=web%2Blofi%3Ahttps%3A%2F%2Foutside.invalid", "unsupported-shape"],
    ["?url=web%2Blofi%3Acollaborative-list%2Fbad%21%2Fitem%2Fitem", "invalid-list-id"],
    ["?url=web%2Blofi%3Acollaborative-list%2Flist%2Fitem%2Fbad%21", "invalid-item-id"],
  ] as const;
  for (const [search, issue] of cases) {
    const result = parseCollaborativeListProtocolTarget(search, options);
    assert(!result.ok && result.issue === issue, `${issue} produced ${JSON.stringify(result)}`);
  }
});

Deno.test("protocol target rejects privileged and ambiguous configuration", () => {
  for (const protocol of ["https", "mailto", "web+UPPER", "web+"]) {
    let rejected = false;
    try {
      parseCollaborativeListProtocolTarget("", { protocol });
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    assert(rejected, `unsafe protocol configuration passed: ${protocol}`);
  }
});
