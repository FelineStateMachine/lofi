import { schema as s } from "jazz-tools";
import { app } from "./schema.ts";

export default s.definePermissions(app, ({ policy, session }) => {
  policy.notes.allowRead.where({ $createdBy: session.user_id });
  policy.notes.allowInsert.always();
  policy.notes.allowUpdate.where({ $createdBy: session.user_id });
  policy.notes.allowDelete.where({ $createdBy: session.user_id });
});
