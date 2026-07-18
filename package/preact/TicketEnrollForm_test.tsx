import { render } from "npm:preact-render-to-string@6.7.0";
import { TicketEnrollForm } from "./TicketEnrollForm.tsx";

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
