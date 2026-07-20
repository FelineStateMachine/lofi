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

// The typed refusals carry their own remediation; the form must not flatten
// them into the generic "paste it again" line — re-pasting cannot fix an
// unprovisioned store or a foreign sync owner.
Deno.test("describeEnrollmentProblem relays typed refusals verbatim", () => {
  const cases: [Error, string][] = [
    [new SyncEnrollmentError("no_schema", "sync"), "no schema deployed"],
    [new SyncEnrollmentError("ticket_rejected"), "revoked or the node was reset"],
    [new SyncOwnerError("alice"), "set up by a different account"],
  ];
  for (const [error, needle] of cases) {
    const problem = describeEnrollmentProblem(error);
    if (problem !== error.message) {
      throw new Error(`typed refusal was rewritten: ${problem}`);
    }
    if (!problem.includes(needle)) {
      throw new Error(`refusal message lost its remediation: ${problem}`);
    }
  }
});

Deno.test("describeEnrollmentProblem keeps the generic line for unknown failures", () => {
  const problem = describeEnrollmentProblem(new TypeError("fetch failed"));
  if (!problem.includes("check the ticket and the node")) {
    throw new Error(`unknown failure leaked internals: ${problem}`);
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
