import { s } from "@nzip/lofi/schema";
import { app } from "./schema.ts";

export default s.definePermissions(app, ({ policy, session }) => {
  policy.incidents.allowInsert.always();
  policy.incidents.allowRead.where({ $createdBy: session.user_id });
  policy.incidents.allowUpdate.where({ $createdBy: session.user_id });
  policy.incidents.allowDelete.where({ $createdBy: session.user_id });
});
