// Package contract tests for the sync-owner pin: fingerprint derivation,
// record round-trip, and the adjudication verdicts the election guard and
// session snapshot read.
import { anchorAppId } from "./data-sink.ts";
import {
  adjudicateSyncOwner,
  clearSyncOwner,
  isSyncOwnerError,
  readSyncOwner,
  readSyncOwnerVerdict,
  recordSyncOwner,
  secretFingerprint,
  SyncOwnerError,
} from "./sync-owner.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

const ownerKey = `lofi:sync-owner:${anchorAppId}`;

function withCleanState(body: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    localStorage.removeItem(ownerKey);
    clearSyncOwner();
    try {
      await body();
    } finally {
      localStorage.removeItem(ownerKey);
      clearSyncOwner();
    }
  };
}

test("the fingerprint is deterministic, non-empty, and secret-sensitive", async () => {
  const first = await secretFingerprint("secret-a");
  assert(first === await secretFingerprint("secret-a"), "one secret must map to one fingerprint");
  assert(/^[0-9a-f]{16}$/.test(first), "the fingerprint is 8 bytes of lowercase hex");
  assert(
    first !== await secretFingerprint("secret-b"),
    "different secrets must map to different fingerprints",
  );
});

test(
  "the owner record round-trips and clears",
  withCleanState(() => {
    assert(readSyncOwner() === null, "a clean device has no owner record");
    recordSyncOwner({ fingerprint: "aabbccddeeff0011", user_id: "user-1" });
    const record = readSyncOwner();
    assert(
      record !== null && record.fingerprint === "aabbccddeeff0011" && record.user_id === "user-1",
      "the persisted record must read back verbatim",
    );
    clearSyncOwner();
    assert(readSyncOwner() === null, "clearing must remove the record");
  }),
);

test(
  "a malformed persisted record reads as unclaimed",
  withCleanState(() => {
    localStorage.setItem(ownerKey, "not json");
    assert(readSyncOwner() === null, "garbage must not adjudicate");
    localStorage.setItem(ownerKey, JSON.stringify({ v: 1, fingerprint: "" }));
    assert(readSyncOwner() === null, "an empty fingerprint must not adjudicate");
    localStorage.setItem(ownerKey, JSON.stringify({ v: 99, fingerprint: "aabbccddeeff0011" }));
    assert(readSyncOwner() === null, "an unknown record version must not adjudicate");
  }),
);

test(
  "adjudication answers unclaimed, self, and foreign, and the verdict is cached",
  withCleanState(() => {
    assert(
      readSyncOwnerVerdict().state === "unadjudicated",
      "before any adjudication the verdict is unadjudicated",
    );
    assert(adjudicateSyncOwner("aabbccddeeff0011").state === "unclaimed", "no record → unclaimed");
    recordSyncOwner({ fingerprint: "aabbccddeeff0011", user_id: "user-1" });
    assert(
      adjudicateSyncOwner("aabbccddeeff0011").state === "self",
      "the recorded fingerprint adjudicates as self",
    );
    const foreign = adjudicateSyncOwner("1122334455667788");
    assert(
      foreign.state === "foreign" && foreign.owner_user_id === "user-1",
      "a different fingerprint adjudicates as foreign, naming the owner",
    );
    assert(
      readSyncOwnerVerdict().state === "foreign",
      "the cached verdict must reflect the latest adjudication",
    );
    clearSyncOwner();
    assert(
      readSyncOwnerVerdict().state === "unadjudicated",
      "clearing the pin resets the cached verdict",
    );
  }),
);

test("the owner error carries its code and the owning account", () => {
  const error = new SyncOwnerError("user-1");
  assert(isSyncOwnerError(error), "the guard must recognize its own error");
  assert(error.code === "owner-mismatch", "the error carries its stable code");
  assert(error.owner_user_id === "user-1", "the error names the owning account");
  assert(!isSyncOwnerError(new Error("other")), "foreign errors are not owner errors");
});
