import { schema as s } from "jazz-tools";

export default s.defineMigration({
  renameTables: {
    tasks: s.renameTableFrom("notes"),
  },
  migrate: {
    tasks: {
      text: s.renameFrom("body"),
      completed: s.add.boolean({ default: false }),
    },
  },
  fromHash: "6c62fec42c35",
  toHash: "ff85ac1d97ee",
  from: {
    notes: s.table({
      body: s.string(),
      createdAt: s.timestamp(),
    }),
  },
  to: {
    tasks: s.table({
      text: s.string(),
      completed: s.boolean(),
      createdAt: s.timestamp(),
    }),
  },
});
