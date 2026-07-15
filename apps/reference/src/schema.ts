import { schema as s } from "jazz-tools";

const schema = {
  tasks: s.table({
    text: s.string(),
    completed: s.boolean(),
    createdAt: s.timestamp(),
  }),
};

type AppSchema = s.Schema<typeof schema>;
export const app: s.App<AppSchema> = s.defineApp(schema);
