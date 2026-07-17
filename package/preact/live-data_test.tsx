import { schema as s } from "jazz-tools";
import { useLiveQuery, useTableMutations } from "./live-data.ts";

const app = s.defineApp({
  records: s.table({ title: s.string(), archived: s.boolean() }),
});

function TypedLiveDataContract() {
  const query = useLiveQuery(() => app.records.select("title"), []);
  const mutations = useTableMutations(app.records);
  const title: string | undefined = query.rows[0]?.title;
  const inserted: Promise<s.RowOf<typeof app.records>> = mutations.insert({
    title: "typed",
    archived: false,
  });
  // @ts-expect-error exact select projections must omit unselected columns.
  query.rows[0]?.archived;
  return { inserted, title };
}

Deno.test("Preact live-data hooks retain exact query and table types", () => {
  if (typeof TypedLiveDataContract !== "function") throw new Error("hook contract was not defined");
});
