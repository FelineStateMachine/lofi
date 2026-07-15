import { serverEnvironmentNames } from "./env_contract.ts";
import { loadNamedEnvironment } from "./load_env.ts";
import { findSecretLeaks } from "./secret_scan.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("server secret loaded only from env file is detected in a build fixture", async () => {
  const directory = await Deno.makeTempDir({ dir: ".", prefix: ".secret-scan-test-" });
  const envPath = `${directory}/.env`;
  const artifactPath = `${directory}/dist/app.js`;
  const secret = "fixture-server-secret-that-must-not-leak";
  try {
    await Deno.mkdir(`${directory}/dist`);
    await Deno.writeTextFile(envPath, `JAZZ_ADMIN_SECRET=${secret}\n`);
    await Deno.writeTextFile(artifactPath, `globalThis.accidental = "${secret}";\n`);
    const environment = await loadNamedEnvironment(
      serverEnvironmentNames,
      envPath,
      () => undefined,
    );
    const leaks = findSecretLeaks(
      [{ path: artifactPath, content: await Deno.readFile(artifactPath) }],
      serverEnvironmentNames
        .map((name) => ({ name, value: environment[name] ?? "" }))
        .filter(({ value }) => value.length > 0),
    );
    assert(leaks.length === 1, "expected one detected leak");
    assert(leaks[0].name === "JAZZ_ADMIN_SECRET", "leak should name the source variable");
    assert(leaks[0].path === artifactPath, "leak should name the artifact path");
    assert(!("value" in leaks[0]), "leak result must not expose the secret value");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
