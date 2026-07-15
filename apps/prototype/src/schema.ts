import { schema as s } from "jazz-tools";

const schema = {
  notes: s.table({
    body: s.string(),
    createdAt: s.timestamp(),
  }),
};

type AppSchema = s.Schema<typeof schema>;
export const app: s.App<AppSchema> = s.defineApp(schema);
