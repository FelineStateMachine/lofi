import { defineLofiApp, getLofiApp } from "./app.ts";
import { assert } from "./test-assert.ts";

Deno.test("defineLofiApp retains schema types and registers package runtime configuration", () => {
  const schema = { notes: { name: "notes" } } as const;
  const app = defineLofiApp({
    name: "notes",
    databaseName: "notes-db",
    schema,
    storage: "durable",
    sync: { adapter: "jazz" },
  });

  assert(app.schema === schema, "defineLofiApp replaced the author schema");
  assert(getLofiApp().databaseName === "notes-db", "runtime config was not registered");
});

Deno.test("defineLofiApp rejects empty identity and database names", () => {
  for (
    const config of [
      { name: "", databaseName: "db" },
      { name: "app", databaseName: "" },
    ]
  ) {
    let message = "";
    try {
      defineLofiApp({
        ...config,
        schema: {},
        storage: "durable",
        sync: { adapter: "jazz" },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("must not be empty"), "empty app configuration was accepted");
  }
});
