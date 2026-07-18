import {
  environmentForApp,
  generateJazzApp,
  JAZZ_MANAGED_SERVER_URL,
  mergeEnv,
  ProvisionError,
  provisionJazzApp,
} from "./provision.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const sampleApp = {
  appId: "00000000-0000-4000-8000-000000000000",
  adminSecret: "admin-secret-value",
  backendSecret: "backend-secret-value",
};

Deno.test("generateJazzApp returns the three secrets from a well-formed response", async () => {
  const app = await generateJazzApp(() => Promise.resolve(jsonResponse(sampleApp)));
  assert(app.appId === sampleApp.appId, "appId should round-trip");
  assert(app.adminSecret === sampleApp.adminSecret, "adminSecret should round-trip");
  assert(app.backendSecret === sampleApp.backendSecret, "backendSecret should round-trip");
});

Deno.test("generateJazzApp rejects a response missing a secret", async () => {
  let threw = false;
  try {
    await generateJazzApp(() => Promise.resolve(jsonResponse({ appId: "only-id" })));
  } catch (error) {
    threw = error instanceof ProvisionError;
  }
  assert(threw, "a missing adminSecret/backendSecret should raise ProvisionError");
});

Deno.test("generateJazzApp surfaces a non-2xx status as a ProvisionError", async () => {
  let threw = false;
  try {
    await generateJazzApp(() => Promise.resolve(jsonResponse({}, 503)));
  } catch (error) {
    threw = error instanceof ProvisionError;
  }
  assert(threw, "an HTTP error should raise ProvisionError");
});

Deno.test("environmentForApp maps onto the four lofi names", () => {
  const env = environmentForApp(sampleApp);
  assert(env.JAZZ_APP_ID === sampleApp.appId, "JAZZ_APP_ID");
  assert(env.JAZZ_SERVER_URL === JAZZ_MANAGED_SERVER_URL, "JAZZ_SERVER_URL defaults to managed");
  assert(env.JAZZ_ADMIN_SECRET === sampleApp.adminSecret, "JAZZ_ADMIN_SECRET");
  assert(env.BACKEND_SECRET === sampleApp.backendSecret, "BACKEND_SECRET");
});

Deno.test("mergeEnv updates existing keys in place and preserves the rest", () => {
  const existing = [
    "# lofi config",
    "JAZZ_APP_ID=",
    "JAZZ_SERVER_URL=",
    "",
    "# unrelated",
    "OTHER_KEY=keep-me",
    "",
  ].join("\n");
  const merged = mergeEnv(existing, environmentForApp(sampleApp));
  assert(merged.includes(`JAZZ_APP_ID=${sampleApp.appId}`), "app id is filled in place");
  assert(merged.includes("OTHER_KEY=keep-me"), "unrelated key is preserved");
  assert(merged.includes("# unrelated"), "comments are preserved");
  assert(merged.includes(`JAZZ_ADMIN_SECRET=${sampleApp.adminSecret}`), "missing key is appended");
  assert((merged.match(/JAZZ_APP_ID=/g) ?? []).length === 1, "no duplicate JAZZ_APP_ID");
});

Deno.test("mergeEnv appends all four keys to an empty file", () => {
  const merged = mergeEnv("", environmentForApp(sampleApp));
  for (const name of ["JAZZ_APP_ID", "JAZZ_SERVER_URL", "JAZZ_ADMIN_SECRET", "BACKEND_SECRET"]) {
    assert(merged.includes(`${name}=`), `${name} should be written`);
  }
});

Deno.test("provisionJazzApp writes an env file and reports the app", async () => {
  let written = "";
  const result = await provisionJazzApp({
    path: ".env",
    fetchImpl: () => Promise.resolve(jsonResponse(sampleApp)),
    readFile: () => Promise.resolve(""),
    writeFile: (_path, contents) => {
      written = contents;
      return Promise.resolve();
    },
  });
  assert(result.app.appId === sampleApp.appId, "returns the generated app");
  assert(result.replaced === false, "a fresh file is not a replacement");
  assert(written.includes(`JAZZ_APP_ID=${sampleApp.appId}`), "env file received the app id");
});

Deno.test("provisionJazzApp refuses to clobber a configured app without force", async () => {
  let fetched = false;
  let threw = false;
  try {
    await provisionJazzApp({
      path: ".env",
      fetchImpl: () => {
        fetched = true;
        return Promise.resolve(jsonResponse(sampleApp));
      },
      readFile: () => Promise.resolve("JAZZ_APP_ID=already-set\n"),
      writeFile: () => Promise.resolve(),
    });
  } catch (error) {
    threw = error instanceof ProvisionError;
  }
  assert(threw, "an existing JAZZ_APP_ID should block without --force");
  assert(!fetched, "it should refuse before generating a throwaway app");
});

Deno.test("provisionJazzApp replaces a configured app when forced", async () => {
  let written = "";
  const result = await provisionJazzApp({
    path: ".env",
    force: true,
    fetchImpl: () => Promise.resolve(jsonResponse(sampleApp)),
    readFile: () => Promise.resolve("JAZZ_APP_ID=already-set\nOTHER=keep\n"),
    writeFile: (_path, contents) => {
      written = contents;
      return Promise.resolve();
    },
  });
  assert(result.replaced === true, "an existing app is reported as replaced");
  assert(written.includes(`JAZZ_APP_ID=${sampleApp.appId}`), "the app id is overwritten");
  assert(written.includes("OTHER=keep"), "unrelated keys survive a forced replace");
});

Deno.test("mergeEnv rewrites every duplicate so the parsed value can never go stale", () => {
  // parseDotenv treats the LAST occurrence as authoritative; updating only the
  // first duplicate reported success while commands kept the old value.
  const existing = [
    "JAZZ_APP_ID=old-first",
    "# duplicate below wins during parsing",
    "JAZZ_APP_ID=old-last",
    "",
  ].join("\n");
  const merged = mergeEnv(existing, { JAZZ_APP_ID: "fresh" });
  const values = merged.split("\n").filter((line) => line.startsWith("JAZZ_APP_ID="));
  assert(values.length === 2, "both duplicate assignments must remain in place");
  assert(
    values.every((line) => line === "JAZZ_APP_ID=fresh"),
    "every duplicate assignment must carry the new value",
  );
});
