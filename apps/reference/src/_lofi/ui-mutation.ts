export async function settleUiMutation(mutation: Promise<unknown>): Promise<void> {
  try {
    await mutation;
  } catch {
    // The runtime owns the visible failure state; the event boundary owns rejection handling.
  }
}
