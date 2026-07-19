import { useEffect, useState } from "preact/hooks";
// Package-owned optional Preact binding for the schema-compatibility gate.
import {
  getSchemaCompatState,
  type SchemaCompatState,
  subscribeSchemaCompat,
} from "../runtime/schema-compat.ts";

export type { SchemaCompatReason, SchemaCompatState } from "../runtime/schema-compat.ts";

/**
 * Subscribes a Preact component to the schema-compatibility gate, so apps can
 * render their own read-only banner in place of the framework default
 * (suppress the default with `pwa: { updateBanner: "none" }` in
 * `defineLofiApp`).
 *
 * @example
 * ```tsx
 * import { useSchemaCompat } from "@nzip/lofi/preact";
 *
 * const compat = useSchemaCompat();
 * if (compat.state === "data-ahead") return <ReadOnlyBanner message={compat.message} />;
 * ```
 *
 * @returns The current compatibility state, kept live via subscription.
 */
export function useSchemaCompat(): SchemaCompatState {
  const [state, setState] = useState<SchemaCompatState>(getSchemaCompatState());
  useEffect(() => subscribeSchemaCompat(setState), []);
  return state;
}
