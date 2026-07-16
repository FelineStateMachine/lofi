import { schema as s } from "jazz-tools";
import { app } from "./schema.ts";

export default s.definePermissions(app, ({ policy, session }) => {
  policy.tasks.allowInsert.always();
  policy.tasks.allowRead.where({ $createdBy: session.user_id });
  policy.tasks.allowUpdate.where({ $createdBy: session.user_id });
  policy.tasks.allowDelete.where({ $createdBy: session.user_id });
});
