import type { VNode } from "preact";
import { useState } from "preact/hooks";
import { AuthError } from "../runtime/auth.ts";
import { isDataSinkError, parseSyncTicket } from "../runtime/data-sink.ts";
import {
  provisionCapabilityStatus,
  type SealOutcome,
  sealProvisionCapability,
} from "../runtime/provision.ts";
import { enrollSyncTicket, isSyncEnrollmentError, type Session } from "../runtime/session.ts";
import { isSyncOwnerError } from "../runtime/sync-owner.ts";
import { getRuntimeDiagnostics } from "../runtime/runtime.ts";

/** Dependencies {@link TicketEnrollForm} accepts for testing and composition. */
export interface TicketEnrollFormProps {
  /** Called with the new session after a successful enrollment. */
  readonly onEnrolled?: (session: Session) => void;
  /** Heading rendered above the form. */
  readonly title?: string;
  /** Enrollment implementation; defaults to the runtime's `enrollSyncTicket`. */
  readonly enroll?: (ticket: string) => Promise<Session>;
  /** Sealing implementation; defaults to the runtime's `sealProvisionCapability`. */
  readonly seal?: () => Promise<SealOutcome>;
}

type Phase =
  | { name: "edit"; problem?: string }
  | { name: "enrolling" }
  | { name: "enrolled"; sealOffer: boolean; warning?: string }
  | { name: "sealing" }
  | { name: "sealed"; portable: boolean }
  | { name: "custody"; reason: "prf-unavailable" | "cancelled" };

// The store answered but could not be reached just now; enrollment was kept,
// and the same status keeps showing in the device report until it clears.
const unreachableWarning =
  "Connected, but the store did not answer just now — if syncing does not start, check the node.";

// The typed refusals carry user-presentable messages naming their remediation;
// everything else gets the generic retry instruction. Exported for tests; the
// entry does not re-export it.
export function describeEnrollmentProblem(error: unknown): string {
  return isDataSinkError(error) || isSyncEnrollmentError(error) || isSyncOwnerError(error)
    ? error.message
    : "Enrollment failed; check the ticket and the node, then paste it again.";
}

// Asks the browser's password manager to save the ticket against this origin
// explicitly (Chromium honors the Credential Management call; other engines
// rely on the form heuristics the markup below satisfies). Best-effort — a
// refusal changes nothing about enrollment.
async function offerTicketToPasswordManager(label: string, ticket: string): Promise<void> {
  const scope = globalThis as unknown as {
    PasswordCredential?: new (init: { id: string; password: string }) => Credential;
    navigator?: { credentials?: { store?: (credential: Credential) => Promise<unknown> } };
  };
  if (!scope.PasswordCredential || !scope.navigator?.credentials?.store) return;
  try {
    await scope.navigator.credentials.store(
      new scope.PasswordCredential({ id: label, password: ticket }),
    );
  } catch {
    // The manager declined or the surface is unavailable; the form heuristics
    // remain the save path.
  }
}

/**
 * The app-connect ticket enrollment form, shaped for password managers: the
 * ticket is a `current-password` field with a label-as-username companion, so
 * the manager offers to save the ticket against this origin on first paste
 * and autofills it later. That custody is the durable copy on devices that
 * cannot seal admin capability behind a passkey — the node stores only
 * hashes, so the manager's copy is the one that survives.
 *
 * After enrolling a provision-scoped ticket whose capability was split (see
 * `provision.ts`), the form offers the passkey-sealing ceremony, and states
 * the password-manager fallback when the ceremony reports `prf-unavailable`
 * or is cancelled.
 *
 * @example
 * ```tsx
 * import { TicketEnrollForm } from "@nzip/lofi/preact";
 *
 * <TicketEnrollForm title="Connect to your node" />;
 * ```
 *
 * @param props Optional callbacks, heading, and injectable implementations.
 * @returns The enrollment form and its follow-on custody choices.
 */
export function TicketEnrollForm({
  onEnrolled,
  title = "Connect a sync location",
  enroll = enrollSyncTicket,
  seal = sealProvisionCapability,
}: TicketEnrollFormProps): VNode {
  const [phase, setPhase] = useState<Phase>({ name: "edit" });
  const [ticket, setTicket] = useState("");
  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);

  function onTicketInput(value: string): void {
    setTicket(value);
    if (!labelEdited) {
      const parsed = parseSyncTicket(value);
      if (parsed?.label) setLabel(parsed.label);
    }
  }

  async function onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    setPhase({ name: "enrolling" });
    try {
      const session = await enroll(ticket);
      await offerTicketToPasswordManager(label || "sync ticket", ticket);
      const provision = provisionCapabilityStatus();
      const unreachable = getRuntimeDiagnostics().storeStatus.state === "store_unavailable";
      setPhase({
        name: "enrolled",
        sealOffer: provision.held && !provision.sealed,
        ...(unreachable ? { warning: unreachableWarning } : {}),
      });
      onEnrolled?.(session);
    } catch (error) {
      setPhase({ name: "edit", problem: describeEnrollmentProblem(error) });
    }
  }

  async function onSeal(): Promise<void> {
    setPhase({ name: "sealing" });
    try {
      const { portable } = await seal();
      setPhase({ name: "sealed", portable });
    } catch (error) {
      if (error instanceof AuthError && error.code === "cancelled") {
        setPhase({ name: "custody", reason: "cancelled" });
        return;
      }
      setPhase({ name: "custody", reason: "prf-unavailable" });
    }
  }

  if (phase.name === "enrolled" && phase.sealOffer) {
    return (
      <section>
        <h2>{title}</h2>
        <p>Connected. This ticket also carries admin access to the store.</p>
        {phase.warning ? <p role="status">{phase.warning}</p> : null}
        <button type="button" onClick={() => void onSeal()}>
          Protect admin access with your passkey
        </button>
        <button
          type="button"
          onClick={() => setPhase({ name: "enrolled", sealOffer: false })}
        >
          Keep it in my password manager instead
        </button>
        <p>
          Either way, admin access is never stored on this device without protection; syncing
          continues on its own.
        </p>
      </section>
    );
  }

  if (phase.name === "sealed") {
    return (
      <section>
        <h2>{title}</h2>
        <p>
          Admin access is sealed behind your passkey
          {phase.portable
            ? ", which syncs across your devices with your passkey provider."
            : ", which stays on this device."} Unlocking it will ask for the passkey.
        </p>
      </section>
    );
  }

  if (phase.name === "custody") {
    return (
      <section>
        <h2>{title}</h2>
        <p>
          {phase.reason === "prf-unavailable"
            ? "This device cannot seal admin access behind a passkey."
            : "Passkey sealing was cancelled."}{" "}
          Admin access stays available until this page closes; keep the ticket in your password
          manager and paste it again when you administer the store. Syncing continues on its own.
        </p>
      </section>
    );
  }

  if (phase.name === "enrolled" || phase.name === "sealing") {
    return (
      <section>
        <h2>{title}</h2>
        <p>{phase.name === "sealing" ? "Waiting for your passkey…" : "Connected and syncing."}</p>
        {phase.name === "enrolled" && phase.warning ? <p role="status">{phase.warning}</p> : null}
      </section>
    );
  }

  return (
    <section>
      <h2>{title}</h2>
      <form onSubmit={(event) => void onSubmit(event)}>
        <label>
          Name for this connection
          <input
            type="text"
            name="username"
            autocomplete="username"
            value={label}
            onInput={(event) => {
              setLabel((event.target as HTMLInputElement).value);
              setLabelEdited(true);
            }}
          />
        </label>
        <label>
          App-connect ticket
          <input
            type="password"
            name="ticket"
            autocomplete="current-password"
            required
            value={ticket}
            onInput={(event) => onTicketInput((event.target as HTMLInputElement).value)}
          />
        </label>
        <button type="submit" disabled={phase.name === "enrolling"}>
          {phase.name === "enrolling" ? "Connecting…" : "Connect"}
        </button>
        {phase.name === "edit" && phase.problem ? <p role="alert">{phase.problem}</p> : null}
      </form>
      <p>
        The ticket is a bearer credential; let your password manager save it here so it can fill it
        next time.
      </p>
    </section>
  );
}
