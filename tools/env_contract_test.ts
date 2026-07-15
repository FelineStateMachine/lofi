import { validateEnvironment } from "./env_contract.ts";
import { loadEnvironment, mergeEnvironment, parseDotenv } from "./load_env.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("empty environment selects local-only mode", () => {
  const result = validateEnvironment({});
  assert(result.ok, "empty local mode should be valid");
  assert(result.mode === "local-only", "expected local-only mode");
});

Deno.test("cloud configuration requires the complete public pair", () => {
  const result = validateEnvironment({ JAZZ_APP_ID: "app" });
  assert(!result.ok, "incomplete cloud configuration should be invalid");
  assert(result.mode === "invalid", "invalid config must not be cloud-configured");
  assert(result.errors.length === 1, "incomplete cloud configuration should fail");
  assert(result.errors[0].includes("JAZZ_SERVER_URL"), "error should name the missing variable");
});

Deno.test("cloud configuration validates its URL without printing values", () => {
  const result = validateEnvironment({
    JAZZ_APP_ID: "app",
    JAZZ_SERVER_URL: "not-a-url",
  });
  assert(!result.ok, "invalid URL should produce an invalid result");
  assert(result.errors.length === 1, "invalid URL should fail");
  assert(!result.errors[0].includes("not-a-url"), "error must not echo configuration values");
});

Deno.test("validated cloud result projects only the complete public pair", () => {
  const result = validateEnvironment({
    JAZZ_APP_ID: "app",
    JAZZ_SERVER_URL: "https://example.test",
    JAZZ_ADMIN_SECRET: "admin-secret",
    BACKEND_SECRET: "backend-secret",
  });
  assert(result.ok && result.mode === "cloud-configured", "cloud pair should validate");
  assert(result.client.JAZZ_APP_ID === "app", "public app ID should be projected");
  assert(!("JAZZ_ADMIN_SECRET" in result.client), "admin secret must not be projected");
  assert(!("BACKEND_SECRET" in result.client), "backend secret must not be projected");
});

Deno.test("dotenv parsing is allowlisted and process values win", () => {
  const parsed = parseDotenv(`
    JAZZ_APP_ID=file-app
    JAZZ_SERVER_URL="https://file.example"
    UNRELATED_SECRET=ignored
  `);
  const merged = mergeEnvironment(
    parsed,
    (name) => name === "JAZZ_APP_ID" ? "process-app" : undefined,
  );
  assert(merged.JAZZ_APP_ID === "process-app", "process environment must take precedence");
  assert(
    merged.JAZZ_SERVER_URL === "https://file.example",
    "file value should fill missing process value",
  );
  assert(!("UNRELATED_SECRET" in merged), "unrelated variables must never enter the projection");
});

Deno.test("optional env file changes mode without exposing values", async () => {
  const path = await Deno.makeTempFile({ dir: ".", prefix: ".env.contract-test-" });
  try {
    await Deno.writeTextFile(
      path,
      "JAZZ_APP_ID=file-app\nJAZZ_SERVER_URL=https://file.example\n",
    );
    const loaded = await loadEnvironment(path, () => undefined);
    const result = validateEnvironment(loaded);
    assert(result.ok && result.mode === "cloud-configured", "env file should configure cloud mode");
  } finally {
    await Deno.remove(path);
  }
});
