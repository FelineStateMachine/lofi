/**
 * Group field-key lifecycle: minting the first generation with the group,
 * wrapping held keys to arriving members, rotating on removal, and repairing
 * missing wraps. Every operation takes an injected context — the same
 * dependency shape the wrapped-key watcher uses — so the sync test suite
 * drives it against real accounts and the group operations wire it to the
 * live runtime.
 *
 * Rotation is deliberately lazy: removal bumps the generation so future
 * writes seal under a key the removed member never receives, while old
 * generations remain readable to them — they already possess that key
 * material, and re-encrypting CRDT history is unsound under concurrent
 * merges. Removal protects future content; the docs say exactly that.
 *
 * @module
 */
import {
  generateFieldKey,
  publicKeyFingerprint,
  SharedFieldError,
  wrapFieldKey,
} from "../schema/shared-crypto.ts";
import {
  getSharedFieldKey,
  heldSharedFieldGenerations,
  installSharedFieldKey,
  requireSharedFieldIdentity,
  sharedKeyScope,
} from "../schema/shared-keyring.ts";
import {
  directoryPublicKey,
  ensureDirectoryEntry,
  verifyAndPinFingerprint,
} from "../runtime/shared-field-keys.ts";

type LifecycleDb = {
  all(query: unknown): Promise<unknown[]>;
  insert(
    table: unknown,
    values: Record<string, unknown>,
  ): { wait(options: { tier: "local" | "global" }): Promise<unknown> };
};

type QueryableTable = { where(condition: Record<string, unknown>): unknown };

/** Everything the lifecycle needs about one group's shared-field wiring. */
export type SharedFieldLifecycleContext = {
  db: LifecycleDb;
  appId: string;
  userId: string;
  /** The group table's declared name — the key scope's first segment. */
  groupTable: string;
  fieldKeys: QueryableTable;
  directory: QueryableTable;
  members: QueryableTable;
};

type WrapRow = {
  groupId: string;
  recipient_user_id: string;
  generation: number;
};

type MemberRow = { user_id: string };

type DirectoryEntry = { user_id: string; algo: string; public_key: string };

/** Why a member could not receive a wrap; the pending state persists. */
export type WrapSkip = "no-directory-entry" | "peer-key-changed";

async function wrapTo(
  context: SharedFieldLifecycleContext,
  groupId: string,
  generation: number,
  fieldKey: Uint8Array,
  recipientUserId: string,
  expectedFingerprint?: string,
): Promise<WrapSkip | null> {
  const identity = requireSharedFieldIdentity();
  const entries = await context.db.all(
    context.directory.where({ user_id: recipientUserId }),
  ) as DirectoryEntry[];
  const entry = entries[0];
  if (entry === undefined) return "no-directory-entry";
  const recipientPublic = directoryPublicKey(entry);
  const observedFingerprint = publicKeyFingerprint(recipientPublic);
  // An out-of-band fingerprint (a lofi2 sharing identity) outranks the
  // directory: a mismatch means the directory is wrong, not the person.
  if (expectedFingerprint !== undefined && expectedFingerprint !== observedFingerprint) {
    return "peer-key-changed";
  }
  if (!verifyAndPinFingerprint(context.appId, recipientUserId, observedFingerprint)) {
    return "peer-key-changed";
  }
  const wrapped = wrapFieldKey({
    fieldKey,
    senderSecret: identity.secret,
    recipientPublic,
    context: {
      groupTable: context.groupTable,
      groupId,
      generation,
      recipientUserId,
      senderUserId: context.userId,
    },
  });
  await context.db.insert(context.fieldKeys as never, {
    groupId,
    recipient_user_id: recipientUserId,
    sender_user_id: context.userId,
    generation,
    wrapped_key: wrapped,
    recipient_fingerprint: observedFingerprint,
    sender_fingerprint: identity.fingerprint,
  }).wait({ tier: "global" });
  return null;
}

async function remoteGenerations(
  context: SharedFieldLifecycleContext,
  groupId: string,
): Promise<WrapRow[]> {
  return await context.db.all(context.fieldKeys.where({ groupId })) as WrapRow[];
}

/**
 * Mints generation 1 for a new group: the key installs locally and wraps to
 * the creator, so the group is writable immediately and other devices of the
 * creator's account unwrap through the ordinary watcher path. Requires the
 * creator's directory entry, publishing it if absent.
 */
export async function bootstrapGroupFieldKey(
  context: SharedFieldLifecycleContext,
  groupId: string,
): Promise<void> {
  const identity = requireSharedFieldIdentity();
  await ensureDirectoryEntry({
    db: context.db as never,
    directory: context.directory,
    userId: context.userId,
    identity,
  });
  const fieldKey = generateFieldKey();
  installSharedFieldKey(sharedKeyScope(context.groupTable, groupId), 1, fieldKey);
  const skip = await wrapTo(context, groupId, 1, fieldKey, context.userId);
  if (skip !== null) {
    throw new SharedFieldError(
      skip === "no-directory-entry" ? "no-directory-entry" : "peer-key-changed",
      "the group key could not be wrapped to its creator",
    );
  }
}

/**
 * Wraps every generation this device holds to a member, skipping wraps that
 * already exist. Returns the skip reason when the member cannot receive keys
 * yet — the member sits in the documented pending state until repair.
 */
export async function wrapHeldKeysForMember(
  context: SharedFieldLifecycleContext,
  groupId: string,
  recipientUserId: string,
  expectedFingerprint?: string,
): Promise<{ wrapped: number; skip: WrapSkip | null }> {
  const scope = sharedKeyScope(context.groupTable, groupId);
  const held = heldSharedFieldGenerations(scope);
  if (held.length === 0) return { wrapped: 0, skip: null };
  const existing = await remoteGenerations(context, groupId);
  const covered = new Set(
    existing
      .filter((row) => row.recipient_user_id === recipientUserId)
      .map((row) => row.generation),
  );
  let wrapped = 0;
  for (const generation of held) {
    if (covered.has(generation)) continue;
    const fieldKey = mustHold(scope, generation);
    const skip = await wrapTo(
      context,
      groupId,
      generation,
      fieldKey,
      recipientUserId,
      expectedFingerprint,
    );
    if (skip !== null) return { wrapped, skip };
    wrapped += 1;
  }
  return { wrapped, skip: null };
}

/**
 * Rotates the group key after a removal: the next generation is minted past
 * every generation visible locally or remotely, installed locally, and
 * wrapped to every remaining member with a directory entry. Members without
 * one stay pending until repair; the removed member never receives the new
 * generation.
 */
export async function rotateGroupFieldKey(
  context: SharedFieldLifecycleContext,
  groupId: string,
  removedUserId: string,
): Promise<void> {
  const scope = sharedKeyScope(context.groupTable, groupId);
  const held = heldSharedFieldGenerations(scope);
  const remote = await remoteGenerations(context, groupId);
  const newest = Math.max(0, ...held, ...remote.map((row) => row.generation));
  const generation = newest + 1;
  const fieldKey = generateFieldKey();
  installSharedFieldKey(scope, generation, fieldKey);
  const members = await context.db.all(
    context.members.where({ groupId }),
  ) as MemberRow[];
  for (const member of members) {
    if (member.user_id === removedUserId) continue;
    await wrapTo(context, groupId, generation, fieldKey, member.user_id);
  }
}

/**
 * Repairs missing wraps: every (member, held generation) pair without a
 * wrapped-key row receives one, directory permitting. The answer to the
 * inherent asynchrony of membership — some online device holding the key
 * eventually wraps; this is that device's move. Returns the number of wraps
 * inserted.
 */
export async function reconcileSharedFieldKeys(
  context: SharedFieldLifecycleContext,
  groupId: string,
): Promise<number> {
  const scope = sharedKeyScope(context.groupTable, groupId);
  const held = heldSharedFieldGenerations(scope);
  if (held.length === 0) return 0;
  const existing = await remoteGenerations(context, groupId);
  const covered = new Set(existing.map((row) => `${row.recipient_user_id}#${row.generation}`));
  const members = await context.db.all(context.members.where({ groupId })) as MemberRow[];
  let wrapped = 0;
  for (const member of members) {
    for (const generation of held) {
      if (covered.has(`${member.user_id}#${generation}`)) continue;
      const skip = await wrapTo(
        context,
        groupId,
        generation,
        mustHold(scope, generation),
        member.user_id,
      );
      if (skip === null) wrapped += 1;
    }
  }
  return wrapped;
}

function mustHold(scope: string, generation: number): Uint8Array {
  const key = getSharedFieldKey(scope, generation);
  if (key === null) {
    throw new SharedFieldError("key-pending", `the field key for ${scope} vanished mid-operation`);
  }
  return key;
}
