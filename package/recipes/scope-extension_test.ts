import {
  createScopeExtension,
  createWebAppOriginAssociation,
  verifyWebAppOriginAssociation,
} from "./scope-extension.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("scope extension helpers produce reciprocal deployment values", () => {
  const declaration = createScopeExtension("https://help.example.com");
  assert(declaration.origin === "https://help.example.com", "origin changed");
  const association = createWebAppOriginAssociation({
    manifestId: "https://app.example.com/products/notes",
    scope: "/notes/",
  });
  assert(
    association["https://app.example.com/products/notes"]?.scope === "/notes/",
    "association did not use the exact manifest ID",
  );
  assert(
    verifyWebAppOriginAssociation(association, {
      manifestId: "https://app.example.com/products/notes",
      scope: "/notes/",
    }),
    "generated association failed verification",
  );
});

Deno.test("association verification fails closed for partial or unexpected values", () => {
  const expected = { manifestId: "https://app.example.com/app", scope: "/help/" };
  for (
    const value of [
      null,
      {},
      { "https://app.example.com/": { scope: "/help/" } },
      { [expected.manifestId]: { scope: "/other/" } },
      { [expected.manifestId]: { scope: "/help/", authorization: true } },
    ]
  ) {
    assert(!verifyWebAppOriginAssociation(value, expected), "invalid association passed");
  }
});

Deno.test("scope extension helpers reject unsafe URLs and paths", () => {
  for (
    const run of [
      () => createScopeExtension("http://help.example.com"),
      () => createScopeExtension("https://help.example.com/path"),
      () => createScopeExtension("https://user:secret@help.example.com"),
      () =>
        createWebAppOriginAssociation({
          manifestId: "https://app.example.com/app?version=1",
          scope: "/help/",
        }),
      () =>
        createWebAppOriginAssociation({
          manifestId: "https://app.example.com/app",
          scope: "/help/../private/",
        }),
    ]
  ) {
    let rejected = false;
    try {
      run();
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    assert(rejected, "unsafe scope extension input passed");
  }
});
