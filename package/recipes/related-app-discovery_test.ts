import { discoverRelatedApplications } from "./related-app-discovery.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const allow = [{
  platform: "play",
  id: "com.example.companion",
  url: "https://play.google.com/store/apps/details?id=com.example.companion",
}] as const;

Deno.test("related app discovery returns exact product-owned matches for presentation", async () => {
  const result = await discoverRelatedApplications({
    allow,
    client: {
      getInstalledRelatedApps: () =>
        Promise.resolve([{
          platform: "play",
          id: "com.example.companion",
          url: "https://play.google.com/store/apps/details?id=com.example.companion",
          version: "private-version",
        }, { platform: "play", id: "attacker.app" }]),
    },
  });
  assert(result.status === "installed", `match failed: ${JSON.stringify(result)}`);
  assert(result.installed.length === 1, "unknown app was exposed");
  assert(!("version" in result.installed[0]), "browser version escaped the presentation boundary");
});

Deno.test("related app discovery makes unsupported, empty, and failure normal states", async () => {
  const unsupported = await discoverRelatedApplications({ allow });
  assert(unsupported.status === "unsupported", "missing API was not unsupported");
  const none = await discoverRelatedApplications({
    allow,
    client: { getInstalledRelatedApps: () => Promise.resolve([]) },
  });
  assert(none.status === "none", "empty result was not normal");
  const failed = await discoverRelatedApplications({
    allow,
    client: { getInstalledRelatedApps: () => Promise.reject(new Error("private")) },
  });
  assert(failed.status === "failed", "API failure did not degrade safely");
});

Deno.test("related app discovery rejects invented declarations", async () => {
  for (
    const declaration of [
      { platform: "invented", id: "app" },
      { platform: "play" },
      { platform: "play", id: "app", url: "http://store.example/app" },
    ]
  ) {
    let rejected = false;
    try {
      await discoverRelatedApplications({ allow: [declaration] });
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    assert(rejected, `invented declaration passed: ${JSON.stringify(declaration)}`);
  }
});
