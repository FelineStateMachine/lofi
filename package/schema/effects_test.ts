import { schema } from "jazz-tools";
import { assert, assertCount } from "../runtime/test-assert.ts";
import type { WriteHandle } from "../runtime/write-handle.ts";
import {
  clearEffectDeclarations,
  type EffectContext,
  type MutationDescriptor,
  s,
  setMutationRuntime,
} from "./mod.ts";

const app = schema.defineApp({
  orders: schema.table({ item: schema.string(), qty: schema.int() }),
});
type Order = schema.RowOf<typeof app.orders>;

type Dispatched = { descriptor: MutationDescriptor; args: readonly unknown[] };

function installRecorder(): { dispatched: Dispatched[]; logs: string[] } {
  const dispatched: Dispatched[] = [];
  const logs: string[] = [];
  setMutationRuntime({
    dispatch(descriptor, args) {
      dispatched.push({ descriptor, args });
      return { stage: "saving" } as unknown as WriteHandle<unknown>;
    },
    recordLog(label) {
      logs.push(label);
    },
  });
  return { dispatched, logs };
}

Deno.test("verbs carry their declared units and dispatch call-site arguments", () => {
  clearEffectDeclarations();
  const recorder = installRecorder();
  const chargeCard = s.effect("chargeCard", app.orders, {
    onSynced: (order: Partial<Order> & { id: string }) => void order.id,
  });
  const placeOrder = s.mutation("placeOrder", s.insert(app.orders), {
    effects: [chargeCard, s.log("order-placed")],
  });
  placeOrder({ item: "tea", qty: 2 });
  assertCount(recorder.dispatched.length, 1, "the verb call must reach the dispatcher");
  const { descriptor, args } = recorder.dispatched[0];
  assert(descriptor.verbName === "placeOrder", "the verb name must reach the runtime");
  assert(descriptor.op.kind === "insert", "the operation kind must reach the runtime");
  assert(
    descriptor.units.map((unit) => unit.effectName).join(",") === "chargeCard,log:order-placed",
    "declared units must ride the descriptor in declaration order",
  );
  assert(
    (args[0] as { item: string }).item === "tea",
    "call-site values must be forwarded untouched",
  );
  clearEffectDeclarations();
});

Deno.test("inline handlers are sugar for an implicit unit named after the verb", () => {
  clearEffectDeclarations();
  const recorder = installRecorder();
  const completeTask = s.mutation("completeTask", s.update(app.orders), {
    onSynced: () => undefined,
  });
  completeTask("row-1", { qty: 3 });
  const descriptor = recorder.dispatched[0].descriptor;
  assertCount(descriptor.units.length, 1, "inline handlers must produce one implicit unit");
  assert(
    descriptor.units[0].effectName === "completeTask",
    "the implicit unit must be named after the verb",
  );
  assert(
    s.log("noise") !== descriptor.units[0],
    "the implicit unit is registered like any other named unit",
  );
  clearEffectDeclarations();
});

Deno.test("effect names are unique per app and collide fast", () => {
  clearEffectDeclarations();
  s.effect("chargeCard", app.orders, {});
  let thrown = false;
  try {
    s.effect("chargeCard", app.orders, {});
  } catch {
    thrown = true;
  }
  assert(thrown, "a duplicate effect name must fail at declaration");
  clearEffectDeclarations();
});

Deno.test("verb names are unique per app and collide fast", () => {
  clearEffectDeclarations();
  s.mutation("placeOrder", s.insert(app.orders));
  let thrown = false;
  try {
    s.mutation("placeOrder", s.insert(app.orders));
  } catch {
    thrown = true;
  }
  assert(thrown, "a duplicate verb name must fail at declaration");
  clearEffectDeclarations();
});

Deno.test("s.log reuses one unit per label and records through the runtime", () => {
  clearEffectDeclarations();
  const recorder = installRecorder();
  const first = s.log("order-placed");
  const second = s.log("order-placed");
  assert(first === second, "one label must resolve to one shared unit");
  const context: EffectContext = {
    journalId: "w1:log:order-placed",
    writeId: "w1",
    verb: "placeOrder",
    table: "orders",
    rowId: "row-1",
    fate: "synced",
    code: null,
    reason: null,
  };
  first.handlers.onSynced?.({ id: "row-1" }, context);
  first.handlers.onRejected?.({ id: "row-1" }, context);
  assertCount(recorder.logs.length, 2, "both fates must record a structured entry");
  clearEffectDeclarations();
});

Deno.test("verb declarations without an installed runtime fail only when called", () => {
  clearEffectDeclarations();
  setMutationRuntime(null as unknown as Parameters<typeof setMutationRuntime>[0]);
  const orphan = s.mutation("orphanVerb", s.remove(app.orders));
  let thrown = false;
  try {
    orphan("row-1");
  } catch (error) {
    thrown = (error as Error).message.includes("runtime is not installed");
  }
  assert(thrown, "calling a verb before the runtime installs must explain itself");
  clearEffectDeclarations();
});

Deno.test("verb call shapes follow the declared operation", () => {
  clearEffectDeclarations();
  const recorder = installRecorder();
  const add = s.mutation("addOrder", s.insert(app.orders));
  const edit = s.mutation("editOrder", s.update(app.orders));
  const drop = s.mutation("dropOrder", s.remove(app.orders));
  add({ item: "tea", qty: 1 });
  edit("row-1", { qty: 2 });
  drop("row-1");
  assertCount(recorder.dispatched.length, 3, "each verb call must dispatch once");
  assert(recorder.dispatched[1].args[0] === "row-1", "update must forward the row id first");
  assert(recorder.dispatched[2].args[0] === "row-1", "remove must forward the row id");
  clearEffectDeclarations();
});
