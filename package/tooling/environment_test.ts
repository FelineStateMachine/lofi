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
