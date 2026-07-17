import {
  type InstalledAppLaunchParameters,
  type InstalledAppLaunchQueue,
  installInstalledAppLaunchConsumer,
  parseInstalledAppLaunchTarget,
} from "./launch-handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("launch target parser accepts only exact-origin URLs inside path scope", () => {
  const valid = parseInstalledAppLaunchTarget(
    "https://app.example/field-notes/tasks/?id=1#selected",
    "https://app.example/field-notes/",
  );
  assert(valid.ok, `valid launch failed: ${JSON.stringify(valid)}`);
  assert(
    valid.target.url === "https://app.example/field-notes/tasks/?id=1#selected",
    "valid launch URL drifted",
  );

  const origin = parseInstalledAppLaunchTarget(
    "https://other.example/field-notes/",
    "https://app.example/field-notes/",
  );
  assert(!origin.ok && origin.issue === "outside-origin", "foreign origin passed");

  const scope = parseInstalledAppLaunchTarget(
    "https://app.example/other/",
    "https://app.example/field-notes/",
  );
  assert(!scope.ok && scope.issue === "outside-scope", "out-of-scope path passed");

  const credentialed = parseInstalledAppLaunchTarget(
    "https://user:secret@app.example/field-notes/",
    "https://app.example/field-notes/",
  );
  assert(
    !credentialed.ok && credentialed.issue === "credentialed-target",
    "credentialed URL passed",
  );
});

Deno.test("launch target parser rejects missing, malformed, and unsafe scope configuration", () => {
  const missing = parseInstalledAppLaunchTarget(undefined, "https://app.example/");
  assert(!missing.ok && missing.issue === "missing-target", "missing launch target passed");
  const malformed = parseInstalledAppLaunchTarget("not a URL", "https://app.example/");
  assert(!malformed.ok && malformed.issue === "invalid-target", "malformed target passed");
  let rejected = false;
  try {
    parseInstalledAppLaunchTarget("https://app.example/", "https://app.example/no-slash");
  } catch (error) {
    rejected = error instanceof TypeError;
  }
  assert(rejected, "ambiguous scope configuration passed");
});

Deno.test("launch consumer feature-detects unsupported browsers", () => {
  const consumer = installInstalledAppLaunchConsumer({
    scope: "https://app.example/",
    onLaunch: () => {
      throw new Error("unsupported consumer ran");
    },
  });
  assert(!consumer.supported, "missing launchQueue was reported as supported");
  consumer.dispose();
});

Deno.test("latest launch consumer owns delivery and stale disposal is harmless", () => {
  let current: (parameters: InstalledAppLaunchParameters) => void = () => {};
  const queue: InstalledAppLaunchQueue = {
    setConsumer(consumer) {
      current = consumer;
    },
  };
  const calls: string[] = [];
  const first = installInstalledAppLaunchConsumer({
    queue,
    scope: "https://app.example/app/",
    onLaunch: () => calls.push("first"),
  });
  const second = installInstalledAppLaunchConsumer({
    queue,
    scope: "https://app.example/app/",
    onLaunch: (target) => calls.push(target.url),
    onRejected: (issue) => calls.push(issue),
  });
  first.dispose();
  current({ targetURL: "https://app.example/app/tasks/" });
  current({ targetURL: "https://other.example/app/tasks/" });
  assert(
    calls.join(",") === "https://app.example/app/tasks/,outside-origin",
    `unexpected launch delivery: ${calls.join(",")}`,
  );
  second.dispose();
  current({ targetURL: "https://app.example/app/ignored/" });
  assert(calls.length === 2, "disposed consumer still handled a launch");
});
