import { render } from "npm:preact-render-to-string@6.7.0";
import { describeEnrollmentProblem, TicketEnrollForm } from "./TicketEnrollForm.tsx";
import { SyncEnrollmentError } from "../runtime/session.ts";
import { SyncOwnerError } from "../runtime/sync-owner.ts";

// The form's manager-facing semantics are the contract: password managers key
// on a real form with a current-password field, a username companion, and a
// genuine submit button. These assertions pin exactly the markup those
// heuristics need.
Deno.test("TicketEnrollForm renders password-manager-compatible form semantics", () => {
  const html = render(<TicketEnrollForm />);
  for (
    const needle of [
      "<form",
      'type="password"',
      'autocomplete="current-password"',
      'autocomplete="username"',
      'type="submit"',
    ]
  ) {
    if (!html.includes(needle)) throw new Error(`manager-facing markup omitted: ${needle}`);
  }
});

Deno.test("TicketEnrollForm states the custody story without overclaiming", () => {
  const html = render(<TicketEnrollForm />);
  if (!html.includes("bearer credential")) {
    throw new Error("the ticket's bearer nature was hidden");
  }
  if (!html.includes("password manager")) {
    throw new Error("the manager custody guidance was omitted");
  }
});

// The typed refusals carry their own remediation text; the form must relay it
// verbatim rather than flattening every failure into the generic retry line.
Deno.test("enrollment problems relay typed refusals and stay generic otherwise", () => {
  const refused = describeEnrollmentProblem(new SyncEnrollmentError("no_schema", "sync"));
  if (!refused.includes("no schema deployed")) {
    throw new Error("the store refusal's own message was not relayed");
  }
  const owned = describeEnrollmentProblem(new SyncOwnerError("user-1"));
  if (!owned.includes("different account")) {
    throw new Error("the owner refusal's own message was not relayed");
  }
  const generic = describeEnrollmentProblem(new Error("socket hang up"));
  if (generic.includes("socket hang up") || !generic.includes("paste it again")) {
    throw new Error("an unclassified failure must map to the generic retry instruction");
  }
});
