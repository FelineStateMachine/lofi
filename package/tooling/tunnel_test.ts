import { denoTunnelOriginFromConfig } from "./tunnel.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Deno Deploy association yields the exact stable local tunnel origin", () => {
  const result = denoTunnelOriginFromConfig({
    deploy: { app: "lofi-dev", org: "felinestatemachine" },
  });
  assert(
    result?.url === "https://lofi-dev--local.felinestatemachine.deno.net/",
    "wrong URL",
  );
});

Deno.test("project without an association does not invent a tunnel URL", () => {
  assert(
    denoTunnelOriginFromConfig({}) === null,
    "unassociated project invented a tunnel origin",
  );
});

Deno.test("unsafe Deploy association cannot become a printed device URL", () => {
  let message = "";
  try {
    denoTunnelOriginFromConfig({ deploy: { app: "lofi.dev", org: "felinestatemachine" } });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("safe DNS label"), "unsafe association did not fail closed");
});
