// Package contract tests for child-process environment projection.
import { childEnvironment, validateEnvironment } from "./environment.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("child environments keep Windows-cased and bootstrap variables", () => {
  const validation = validateEnvironment({});
  assert(validation.ok, "an empty environment must validate as local-only");
  const child = childEnvironment(validation, {
    Path: "C:\\Windows;C:\\bin",
    SystemRoot: "C:\\Windows",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
    USERPROFILE: "C:\\Users\\dev",
    SECRET_TOKEN: "never",
  });
  // Children run with a cleared environment; Windows delivers names with
  // arbitrary casing, and dropping them breaks DLL and executable resolution.
  assert(child.Path === "C:\\Windows;C:\\bin", "Windows-cased Path must be forwarded");
  assert(child.SystemRoot === "C:\\Windows", "SystemRoot must survive the cleared environment");
  assert(child.ComSpec?.endsWith("cmd.exe"), "ComSpec must be forwarded");
  assert(child.USERPROFILE === "C:\\Users\\dev", "per-user state must be forwarded");
  assert(!("SECRET_TOKEN" in child), "unlisted variables must never be forwarded");
  assert(
    child.JAZZ_ADMIN_SECRET === "" && child.BACKEND_SECRET === "",
    "server secrets remain explicitly cleared",
  );
});

Deno.test("child environments still forward the POSIX allowlist exactly", () => {
  const validation = validateEnvironment({});
  assert(validation.ok, "an empty environment must validate as local-only");
  const child = childEnvironment(validation, {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    LANG: "en_US.UTF-8",
    LD_PRELOAD: "/tmp/evil.so",
  });
  assert(child.PATH === "/usr/bin" && child.HOME === "/home/dev", "allowlist must be forwarded");
  assert(child.LANG === "en_US.UTF-8", "locale must be forwarded");
  assert(!("LD_PRELOAD" in child), "non-allowlisted variables must be dropped");
});
