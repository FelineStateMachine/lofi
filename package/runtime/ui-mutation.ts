/** Lets event handlers await a UI mutation without leaking an unhandled rejection. */
export async function settleUiMutation(mutation: PromiseLike<unknown>): Promise<void> {
  // Package-owned UI mutation settlement.
  try {
    await mutation;
  } catch {
    // The runtime owns the visible failure state; the event boundary owns rejection handling.
  }
}
