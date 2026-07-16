export const checklistUi = {
  newItem: "New item",
  addFrom: (island: string) => `Add from ${island}`,
  edit: (body: string) => `Edit ${body}`,
  save: (body: string) => `Save ${body}`,
  delete: (body: string) => `Delete ${body}`,
  complete: (body: string) => `Complete ${body}`,
  writeFailed: "Write failed:",
  lastWrite: (tier: "local" | "global") => `last write ${tier}`,
} as const;
