function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("real environment files are ignored and untracked", async () => {
  const ignored = await new Deno.Command("git", {
    args: ["check-ignore", ".env"],
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(ignored.success, ".env must be ignored");

  const tracked = await new Deno.Command("git", {
    args: ["ls-files", ".env", ".env.*"],
    stdout: "piped",
  }).output();
  const trackedFiles = new TextDecoder().decode(tracked.stdout).trim().split("\n").filter(Boolean);
  assert(
    trackedFiles.every((path) => path === ".env.example"),
    `only .env.example may be tracked, found: ${trackedFiles.join(", ")}`,
  );
});

Deno.test("environment example contains names but no values", async () => {
  const example = await Deno.readTextFile(".env.example");
  const assignments = example.split("\n").filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line));
  assert(assignments.length === 5, "expected five documented environment variables");
  assert(assignments.every((line) => line.endsWith("=")), ".env.example must not contain values");
});
