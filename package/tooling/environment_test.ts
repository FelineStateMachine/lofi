import { childEnvironment, validateEnvironment } from "./environment.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("local child environment clears Jazz configuration without inventing Vite inputs", () => {
  const validation = validateEnvironment({});
  assert(validation.ok, "empty configuration should select local-only mode");
  const environment = childEnvironment(validation, {
    PATH: "/test/bin",
    VITE_JAZZ_APP_ID: "ambient-value",
    UNRELATED: "ambient-value",
  });
  assert(environment.PATH === "/test/bin", "allowlisted process input was dropped");
  assert(environment.JAZZ_APP_ID === "", "local mode retained JAZZ_APP_ID");
  assert(environment.JAZZ_SERVER_URL === "", "local mode retained JAZZ_SERVER_URL");
  assert(environment.JAZZ_ADMIN_SECRET === "", "local mode retained JAZZ_ADMIN_SECRET");
  assert(environment.BACKEND_SECRET === "", "local mode retained BACKEND_SECRET");
  assert(!("VITE_JAZZ_APP_ID" in environment), "local mode invented a Vite-only Jazz input");
  assert(!("UNRELATED" in environment), "child environment retained unrelated ambient input");
});

Deno.test("tunnel-injected environment projects only the public Jazz pair", () => {
  const validation = validateEnvironment({
    JAZZ_APP_ID: "public-app-id",
    JAZZ_SERVER_URL: "https://sync.example.test",
  });
  assert(validation.ok && validation.mode === "cloud-configured", "cloud pair was not accepted");
  const environment = childEnvironment(validation, {
    PATH: "/test/bin",
    DENO_DEPLOY_TOKEN: "must-not-reach-astro",
    JAZZ_ADMIN_SECRET: "must-not-reach-astro",
    BACKEND_SECRET: "must-not-reach-astro",
  });
  assert(environment.JAZZ_APP_ID === "public-app-id", "public Jazz app ID was dropped");
  assert(
    environment.JAZZ_SERVER_URL === "https://sync.example.test",
    "public Jazz server URL was dropped",
  );
  assert(environment.JAZZ_ADMIN_SECRET === "", "Jazz admin secret reached Astro");
  assert(environment.BACKEND_SECRET === "", "backend secret reached Astro");
  assert(!("DENO_DEPLOY_TOKEN" in environment), "Deno Deploy token reached Astro");
});
