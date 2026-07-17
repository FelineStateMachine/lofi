import { useCallback, useEffect, useState } from "preact/hooks";
import {
  confirmPhraseAccess,
  createBackupPasskey,
  enableSyncBackup,
  isAuthError,
  isRecoveryError,
  readSession,
  restoreFromRecoveryPhrase,
  revealRecoveryPhrase,
  type Session,
  stopSyncBackup,
} from "@nzip/lofi";

/**
 * Author-owned account example. lofi is local-first: the app already opened on a
 * device-local account with no sign-in. This island offers the *opt-in* upgrade —
 * back up and sync the account, and recover it elsewhere — using only the
 * public `@nzip/lofi` session primitives. Delete it if your app is local-only,
 * or restyle it freely; framework implementation remains package-owned.
 *
 * It renders only when a managed Jazz app is configured (`JAZZ_APP_ID` /
 * `JAZZ_SERVER_URL`, e.g. via `deno task jazz:provision`), because a recovery
 * phrase only matters once there is somewhere to sync to.
 */

type Busy = "enable" | "stop" | "reveal" | "restore" | "protect";

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
  return error instanceof Error ? error.message : String(error);
}

export default function AccountGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [phraseInput, setPhraseInput] = useState("");
  const [restoring, setRestoring] = useState(false);
  // Set when a backup proceeded without a passkey guard (WebAuthn unavailable),
  // so the phrase block can say so honestly rather than imply a confirmation.
  const [unguarded, setUnguarded] = useState(false);

  useEffect(() => {
    setSession(readSession());
  }, []);

  const run = useCallback(
    (kind: Busy, action: () => Promise<unknown>) => {
      setBusy(kind);
      setError(null);
      void action().then(
        (result) => {
          if (result && typeof result === "object" && "syncAvailable" in result) {
            setSession(result as Session);
          }
        },
        (cause) => setError(describe(cause)),
      ).finally(() => setBusy(null));
    },
    [],
  );

  // Nothing to back up to when no Jazz app is configured — stay out of the way.
  if (!session || !session.syncAvailable) return null;

  const disabled = busy !== null;

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
      <button
        type="button"
        class="account-secondary"
        onClick={() => void navigator.clipboard?.writeText(phrase).catch(() => {})}
      >
        Copy phrase
      </button>
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
          {session.phraseGuarded
            ? " Revealing the phrase asks for your passkey first."
            : " Reveal the phrase again any time to save it on another device."}
        </p>
        <div class="account-actions">
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
                  return readSession();
                })}
            >
              {busy === "protect" ? "Setting up…" : "Protect phrase with a passkey"}
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
        along. You will create a passkey first, so revealing your recovery phrase asks for it.
      </p>
      <div class="account-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            run("enable", async () => {
              setUnguarded(!(await createBackupPasskey()));
              setPhrase(await revealRecoveryPhrase());
              return await enableSyncBackup();
            })}
        >
          {busy === "enable" ? "Backing up…" : "Back up & enable sync"}
        </button>
        <button
          type="button"
          class="account-secondary"
          disabled={disabled}
          onClick={() => {
            setError(null);
            setRestoring((value) => !value);
          }}
        >
          {restoring ? "Cancel" : "Restore from recovery phrase"}
        </button>
      </div>
      {phraseBlock}
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
                  restoreFromRecoveryPhrase(phraseInput).then((next) => {
                    setRestoring(false);
                    setPhraseInput("");
                    return next;
                  }),
              )}
          >
            {busy === "restore" ? "Restoring…" : "Restore account"}
          </button>
        </div>
      )}
      {error && <p class="account-error" role="alert">{error}</p>}
    </section>
  );
}
