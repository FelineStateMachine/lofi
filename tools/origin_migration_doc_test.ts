const path = new URL("../docs/application-origin-migration.md", import.meta.url);
const source = await Deno.readTextFile(path);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("origin migration playbook retains the complete repeatable safety contract", () => {
  for (
    const boundary of [
      "service workers",
      "Cache Storage",
      "IndexedDB",
      "OPFS",
      "permissions",
      "WebAuthn",
      "manifest identity",
    ]
  ) {
    assert(source.includes(boundary), `origin playbook omitted ${boundary}`);
  }
  for (let index = 1; index <= 12; index++) {
    const id = `ORIGIN-${String(index).padStart(2, "0")}`;
    assert(source.includes(`- [ ] \`${id}\``), `origin checklist omitted ${id}`);
  }
  assert(source.includes("## Partial migration and rollback"), "rollback section is missing");
  assert(source.includes("offline users"), "offline-user retirement case is missing");
  assert(
    source.includes("Never put an account secret") &&
      source.includes("never copies account secrets"),
    "cross-origin secret-copy prohibition is missing",
  );
});
