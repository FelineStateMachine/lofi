export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function assertCount(actual: number, expected: number, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}
