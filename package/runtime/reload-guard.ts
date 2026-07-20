/**
 * Package-owned reload budget for framework-driven page reloads.
 *
 * The runtime reloads the document at two well-defined boundaries (sync
 * election and principal replacement on SharedWorker browsers). A device
 * whose persisted state contradicts itself can turn those boundaries into a
 * reload cycle. The budget counts framework-driven reloads in session
 * storage — per tab, surviving each reload — and a settled boot clears it,
 * so only an unbroken reload-without-ready sequence ever reaches the limit.
 *
 * @module
 */

import { anchorAppId } from "./data-sink.ts";

/** The storage shape the budget needs; tests inject a plain map-backed one. */
export type ReloadCounterStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const reloadCountKey = `lofi:reload-count:${anchorAppId}`;

// Two consecutive framework reloads without a settled boot are legitimate
// (election, then e.g. an immediate principal replacement); the third is a
// cycle.
const maxReloadAttempts = 3;

function defaultStorage(): ReloadCounterStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Records one framework-driven reload attempt and answers whether it may
 * proceed. Without session storage the budget degrades open — every attempt
 * is allowed — because there is then also no cross-reload state to loop on.
 */
export function noteReloadAttempt(
  storage: ReloadCounterStorage | null = defaultStorage(),
): { allowed: boolean; count: number } {
  if (storage === null) return { allowed: true, count: 0 };
  try {
    const previous = Number(storage.getItem(reloadCountKey) ?? "0");
    const count = (Number.isFinite(previous) && previous >= 0 ? previous : 0) + 1;
    storage.setItem(reloadCountKey, String(count));
    return { allowed: count < maxReloadAttempts, count };
  } catch {
    return { allowed: true, count: 0 };
  }
}

/** Clears the budget — called when a boot settles into a working runtime. */
export function resetReloadAttempts(
  storage: ReloadCounterStorage | null = defaultStorage(),
): void {
  if (storage === null) return;
  try {
    storage.removeItem(reloadCountKey);
  } catch {
    // A storage failure only delays the reset until the next settled boot.
  }
}
