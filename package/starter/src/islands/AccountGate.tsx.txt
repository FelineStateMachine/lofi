import { useCallback, useEffect, useState } from "preact/hooks";
import {
  confirmPhraseAccess,
  createBackupPasskey,
  createRecoverablePasskeyBackup,
  enableSyncBackup,
  isAccountReplacementError,
  isAuthError,
  isRecoverablePasskeyError,
  isRecoveryError,
  readAccountSession,
  restoreFromPasskey,
  restoreFromRecoveryPhrase,
  revealRecoveryPhrase,
  type Session,
  stopSyncBackup,
} from "@nzip/lofi";
import { encodeSharingIdentity } from "@nzip/lofi/access";
import { TicketEnrollForm } from "@nzip/lofi/preact";

/**
 * Author-owned account example. lofi is local-first: the app already opened on a
 * device-local account with no sign-in. This island offers the *opt-in* upgrade —
 * back up and sync the account, and recover it elsewhere — using only the
 * public `@nzip/lofi` session primitives. Delete it if your app is local-only,
 * or restyle it freely; framework implementation remains package-owned.
 *
 * With no sync location — no compiled managed app and no enrolled ticket — it
 * offers the connect step instead: enroll an app-connect ticket (a password
 * manager autofills a saved one), and restore is available first, so a fresh
 * device can recover its identity before or after choosing where to sync.
 */

type Busy =
  | "enable"
  | "stop"
  | "reveal"
  | "restore"
  | "passkey-restore"
  | "recoverable"
  | "protect";

// Turns any thrown value into a sentence a person can act on.
function describe(error: unknown): string {
  if (isAuthError(error)) {
    switch (error.code) {
      case "cancelled":
        return "Passkey prompt dismissed — your recovery phrase was not shown.";
      case "unsupported":
        return "This browser does not support passkeys.";
      default:
        return error.message;
    }
  }
  if (isRecoveryError(error)) return error.message;
  if (isRecoverablePasskeyError(error) || isAccountReplacementError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export default function AccountGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [phraseInput, setPhraseInput] = useState("");
  // Backup happens in two steps: reveal the phrase first, then enable sync
  // only after the user confirms it is saved — enabling sync reloads the
  // document, which would wipe an unread phrase from the screen.
  const [pendingEnable, setPendingEnable] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmReplacement, setConfirmReplacement] = useState(false);
  const sharingIdentity = session?.user_id ? encodeSharingIdentity(session.user_id) : null;
  // Set when a backup proceeded without a passkey guard (WebAuthn unavailable),
  // so the phrase block can say so honestly rather than imply a confirmation.
  const [unguarded, setUnguarded] = useState(false);

  useEffect(() => {
    void readAccountSession().then(setSession, (cause) => setError(describe(cause)));
  }, []);

  // Every account action funnels through here: one busy flag, one error line,
  // and any returned Session becomes the new snapshot.
  const run = useCallback(
    (kind: Busy, action: () => Promise<Session | void>) => {
      setBusy(kind);
      setError(null);
      void action().then(
        (result) => {
          if (result) setSession(result);
        },
        (cause) => setError(describe(cause)),
      ).finally(() => setBusy(null));
    },
    [],
  );

  if (!session) return null;

  const disabled = busy !== null;

  // Restore works without a sync location: it replaces the local identity, and
  // synced data arrives once a location exists. Rendered in both the connect
  // and the back-up states.
  const restoreBlock = (
    <>
      <div class="account-actions">
        <button
          type="button"
          class="account-secondary"
          disabled={disabled || !confirmReplacement}
          onClick={() => {
            setRestoring(true);
            run("passkey-restore", () =>
              restoreFromPasskey({ confirmLocalReplacement: confirmReplacement }).then((next) => {
                setConfirmReplacement(false);
                return next;
              }));
          }}
        >
          {busy === "passkey-restore" ? "Restoring…" : "Use passkey"}
        </button>
        <button
          type="button"
          class="account-secondary"
          disabled={disabled || !confirmReplacement}
          onClick={() => {
            setError(null);
            setRestoring((value) =>
              !value
            );
          }}
        >
          {restoring ? "Cancel" : "Restore from recovery phrase"}
        </button>
      </div>
      <label class="account-note">
        <input
          type="checkbox"
          checked={confirmReplacement}
          disabled={disabled}
          onChange={(event) => setConfirmReplacement(event.currentTarget.checked)}
        />{" "}
        I understand restore replaces this device's current local account and unsynced data may be
        lost.
      </label>
      {restoring && (
        <div class="account-field">
          <label for="recovery-input">Recovery phrase</label>
          <textarea
            id="recovery-input"
            value={phraseInput}
            onInput={(event) => setPhraseInput(event.currentTarget.value)}
            placeholder="word one word two …"
            rows={3}
            disabled={disabled}
          />
          <p class="account-note">
            Restoring replaces this device's local account with the recovered one — any data created
            here that is not backed up will be discarded.
          </p>
          <button
            type="button"
            disabled={disabled || phraseInput.trim().length === 0}
            onClick={() =>
              run(
                "restore",
                () =>
                  restoreFromRecoveryPhrase(phraseInput, {
                    confirmLocalReplacement: confirmReplacement,
                  }).then((next) => {
                    setRestoring(false);
                    setPhraseInput("");
                    setConfirmReplacement(false);
                    return next;
                  }),
              )}
          >
            {busy === "restore" ? "Restoring…" : "Restore account"}
          </button>
        </div>
      )}
    </>
  );

  // No sync location yet: offer the connect step, with restore available so a
  // fresh device recovers its identity before or after choosing where to sync.
  if (!session.syncAvailable) {
    return (
      <section class="account account-out" aria-labelledby="account-title">
        <header>
          <p class="eyebrow">Account</p>
          <h2 id="account-title">Connect a sync location</h2>
        </header>
        <p>
          You are working on a private, on-device account. To sync or recover it, connect a sync
          location: paste the app-connect ticket from your node — a password manager fills a saved
          one. Restoring an account works before or after connecting; synced data arrives once a
          location exists.
        </p>
        <TicketEnrollForm
          title="Enroll an app-connect ticket"
          onEnrolled={() => {
            void readAccountSession().then(setSession, (cause) => setError(describe(cause)));
          }}
        />
        {restoreBlock}
        {error && <p class="account-error" role="alert">{error}</p>}
      </section>
    );
  }

  const phraseBlock = phrase && (
    <div class="account-phrase">
      <p class="account-note">
        Write these {phrase.split(" ").length}{" "}
        words down and keep them somewhere safe. Anyone with them can open this account; lose every
        copy and the account cannot be recovered.
      </p>
      {unguarded && (
        <p class="account-note">
          A passkey could not be created on this browser or origin, so this reveal was not confirmed
          with one. Save the phrase carefully.
        </p>
      )}
      <ol class="account-words" aria-label="Recovery phrase">
        {phrase.split(" ").map((word, index) => <li key={index}>{word}</li>)}
      </ol>
    </div>
  );

  if (session.backedUp) {
    return (
      <section class="account account-in" aria-labelledby="account-title">
        <header>
          <p class="eyebrow">Account</p>
          <h2 id="account-title">Backed up &amp; syncing</h2>
        </header>
        <p>
          This account replicates to your managed Jazz app and can be recovered with its phrase.
          {session.passkeyRecoverable
            ? " Its account-recovery passkey can restore the same identity where your passkey provider makes it available."
            : " Create an account-recovery passkey if this browser supports one."}
        </p>
        {sharingIdentity && (
          <p class="account-note">
            Share identity: <code data-sharing-identity>{sharingIdentity}</code>
          </p>
        )}
        <div class="account-actions">
          {!session.passkeyRecoverable && (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                run("recoverable", async () => {
                  await createRecoverablePasskeyBackup();
                  return readAccountSession();
                })}
            >
              {busy === "recoverable" ? "Creating…" : "Create account-recovery passkey"}
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (phrase) {
                setPhrase(null);
                return;
              }
              run("reveal", async () => {
                await confirmPhraseAccess();
                setPhrase(await revealRecoveryPhrase());
              });
            }}
          >
            {busy === "reveal" ? "Revealing…" : phrase ? "Hide phrase" : "Show recovery phrase"}
          </button>
          {!session.phraseGuarded && (
            <button
              type="button"
              class="account-secondary"
              disabled={disabled}
              onClick={() =>
                run("protect", async () => {
                  setUnguarded(!(await createBackupPasskey()));
                  return readAccountSession();
                })}
            >
              {busy === "protect" ? "Setting up…" : "Add local phrase-reveal guard"}
            </button>
          )}
          <button
            type="button"
            class="account-secondary"
            disabled={disabled}
            onClick={() => {
              setPhrase(null);
              run("stop", stopSyncBackup);
            }}
          >
            {busy === "stop" ? "Stopping…" : "Stop syncing"}
          </button>
        </div>
        {phraseBlock}
        {error && <p class="account-error" role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <section class="account account-out" aria-labelledby="account-title">
      <header>
        <p class="eyebrow">Account</p>
        <h2 id="account-title">Back up &amp; sync</h2>
      </header>
      <p>
        You are working on a private, on-device account — no sign-in, nothing sent anywhere. Back it
        up to sync across your devices and recover it if this one is lost. Your existing data comes
        along. A recoverable passkey is the quick return path; the recovery phrase remains the
        portable bearer-secret fallback.
      </p>
      <div class="account-actions">
        {!pendingEnable && (
          <button
            type="button"
            disabled={disabled}
            onClick={() =>
              run("enable", async () => {
                try {
                  await createRecoverablePasskeyBackup();
                  setUnguarded(false);
                } catch (cause) {
                  if (!isRecoverablePasskeyError(cause) || cause.code !== "unsupported") {
                    throw cause;
                  }
                  setUnguarded(true);
                }
                setPhrase(await revealRecoveryPhrase());
                setPendingEnable(true);
              })}
          >
            {busy === "enable" ? "Backing up…" : "Back up & enable sync"}
          </button>
        )}
      </div>
      {restoreBlock}
      {phraseBlock}
      {pendingEnable && (
        <div class="account-actions">
          <p class="account-note">
            Sync starts once you confirm the phrase is saved — the page reloads and the phrase will
            not be shown again automatically.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => run("enable", enableSyncBackup)}
          >
            {busy === "enable" ? "Enabling sync…" : "I saved my phrase — enable sync"}
          </button>
        </div>
      )}
      {error && <p class="account-error" role="alert">{error}</p>}
    </section>
  );
}
