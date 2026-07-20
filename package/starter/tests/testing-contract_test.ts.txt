import type {
  BrowserTestClient,
  ConcurrentOfflineScenario,
  ReadinessOptions,
  TwoClientFixture,
} from "@nzip/lofi/testing";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("generated projects type-check the public local-first browser helpers", () => {
  type TestingContract = {
    client: BrowserTestClient;
    fixture: TwoClientFixture;
    readiness: ReadinessOptions;
    scenario: ConcurrentOfflineScenario<string>;
  };
  const exportedNames = ["client", "fixture", "readiness", "scenario"] satisfies readonly (
    keyof TestingContract
  )[];
  assert(exportedNames.length === 4, "@nzip/lofi/testing contract was not checked");
});
