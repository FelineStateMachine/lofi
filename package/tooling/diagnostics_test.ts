import { join } from "node:path";
import { createProject } from "../create_core.ts";
import { doctorReport } from "./diagnostics.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeTestRoot(): Promise<string> {
  return Deno.makeTempDir({ dir: ".", prefix: ".lofi-doctor-test-" });
}

Deno.test("doctor reports value-free local capability states without booting Astro", async () => {
  const cwd = await makeTestRoot();
  try {
    const project = await createProject({ cwd, name: "starter" });
    const report = await doctorReport({
      root: project.destination,
      environment: {},
      denoVersion: "2.9.0",
    });
    assert(!report.blocked, "valid generated project should not be blocked");
    assert(report.validation.mode === "local-only", "empty environment should be local-only");
    assert(
      report.diagnostics.some((item) => item.name === "Storage" && item.status === "pending"),
      "doctor must defer browser-only storage facts",
    );
    assert(
      report.diagnostics.some((item) =>
        item.name === "Device URL" &&
        item.status === "pending" &&
        item.remediation?.includes("deno task --tunnel dev")
      ),
      "doctor must report the first-class Deno Tunnel action",
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("doctor blocks partial configuration without exposing values", async () => {
  const cwd = await makeTestRoot();
  const secretValue = "must-not-appear-in-doctor-output";
  try {
    const project = await createProject({ cwd, name: "starter" });
    const report = await doctorReport({
      root: project.destination,
      environment: {
        JAZZ_APP_ID: secretValue,
        JAZZ_ADMIN_SECRET: secretValue,
      },
      denoVersion: "2.9.0",
    });
    assert(report.blocked, "partial cloud configuration must block boot");
    assert(report.validation.mode === "invalid", "partial cloud configuration must be invalid");
    assert(
      !JSON.stringify(report).includes(secretValue),
      "doctor report exposed an environment value",
    );
    assert(
      report.diagnostics.some((item) => item.remediation?.includes("edit `.env` once")),
      "configuration blocker must include a one-edit remediation",
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

Deno.test("doctor blocks unsupported Deno and incomplete generated layouts", async () => {
  const root = await makeTestRoot();
  try {
    await Deno.writeTextFile(join(root, "deno.json"), "{}\n");
    const report = await doctorReport({ root, environment: {}, denoVersion: "2.8.9" });
    assert(report.blocked, "unsupported runtime and missing files must block boot");
    assert(
      report.diagnostics.some((item) => item.name === "Deno" && item.status === "blocker"),
      "old Deno was not reported",
    );
    assert(
      report.diagnostics.some((item) => item.name === "Project" && item.status === "blocker"),
      "missing project files were not reported",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
