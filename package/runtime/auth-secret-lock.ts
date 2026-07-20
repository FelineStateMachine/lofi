/**
 * Cross-tab coordination for account-secret store access.
 *
 * The vendor secret store persists the account secret with a localStorage
 * check-then-write, which is not atomic across tabs: two first tabs could
 * each mint a secret, the last write would win, and the losing tab would
 * spend its session writing under an identity that disappears on reload.
 * Serializing every read-or-create and replacement behind one exclusive,
 * app-scoped Web Lock closes that window — the second tab enters the store
 * only after the first tab's write is visible.
 *
 * The durable capability gate requires Web Locks before the runtime opens, so
 * a browser boot always holds the lock. Without a lock manager (single-process
 * tests) the operation runs directly; there is no concurrent tab to exclude.
 *
 * @module
 */

/** Minimal Web Locks surface, injectable for tests. */
export type AuthSecretLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T>;
};

/** The exclusive Web Lock name serializing one app's secret-store access. */
export function authSecretLockName(appId: string): string {
  const key = appId.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "app";
  return `lofi-auth-secret-${key}`;
}

function defaultLocks(): AuthSecretLockManager | undefined {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  return typeof locks?.request === "function"
    ? locks as unknown as AuthSecretLockManager
    : undefined;
}

/** Runs one secret-store operation under the app's exclusive secret lock. */
export async function withAuthSecretLock<T>(
  appId: string,
  operation: () => Promise<T>,
  locks: AuthSecretLockManager | undefined = defaultLocks(),
): Promise<T> {
  if (!locks) return await operation();
  return await locks.request(
    authSecretLockName(appId),
    { mode: "exclusive" },
    () => operation(),
  );
}
