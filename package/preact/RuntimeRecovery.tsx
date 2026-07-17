import type { JSX } from "preact";
import {
  reloadAfterRuntimeStartupFailure,
  type RuntimeStartupFailure,
} from "../runtime/startup-recovery.ts";

/** Inputs for Lofi's explicit persistent-runtime recovery action. */
export type RuntimeRecoveryProps = {
  failure: RuntimeStartupFailure | null;
  reload?: () => void;
};

/** Renders recovery only when another tab is running an incompatible broker version. */
export function RuntimeRecovery({ failure, reload }: RuntimeRecoveryProps): JSX.Element | null {
  if (failure?.code !== "broker-incompatible") return null;
  return (
    <div class="runtime-recovery" role="alert">
      <h4>Close other app tabs</h4>
      <p>{failure.message}</p>
      <p>This tab will not reload or retry automatically.</p>
      <button
        type="button"
        onClick={() => reloadAfterRuntimeStartupFailure(reload)}
      >
        Reload app
      </button>
    </div>
  );
}
