import {
  IncompatibleBrowserBrokerConfigurationError,
  type IncompatibleBrowserBrokerConfigurationHandler,
} from "jazz-tools";
import { LofiConfigurationError } from "./app.ts";
import { DurableStorageUnsupportedError } from "./device-capabilities.ts";

/** Stable categories for failures that prevent Lofi's persistent runtime from opening. */
export type RuntimeStartupFailureCode =
  | "broker-incompatible"
  | "configuration-error"
  | "reload-loop"
  | "storage-startup-failed"
  | "unsupported-capabilities";

/** Non-sensitive runtime context retained for diagnostics and recovery UI. */
export type RuntimeStartupFailure = {
  code: RuntimeStartupFailureCode;
  runtimeMode: "local" | "managed";
  message: string;
};

const startupMessages: Record<RuntimeStartupFailureCode, string> = {
  "broker-incompatible":
    "Another tab for this app is running an incompatible version. Close every other app tab, then reload this tab.",
  "configuration-error":
    "The Lofi runtime configuration is invalid. Run deno task doctor, fix the first blocker, then reload.",
  "reload-loop":
    "The app kept reloading without reaching a working runtime, so automatic reloads stopped. Check the device report's account and sync state, then reload manually.",
  "storage-startup-failed":
    "Durable storage could not start. Run deno task doctor, fix the first blocker, then reload.",
  "unsupported-capabilities":
    "This browser cannot provide Lofi's durable storage requirements. Open the stable HTTPS app URL in a supported browser.",
};

/** Lofi-owned error boundary for a rejected persistent runtime startup. */
export class RuntimeStartupError extends Error {
  /** Stable error class name for diagnostics and UI boundaries. */
  override readonly name = "RuntimeStartupError";
  /** Stable public category without vendor-specific error details. */
  readonly code: RuntimeStartupFailureCode;
  /** Non-sensitive failure snapshot retained for diagnostics. */
  readonly failure: RuntimeStartupFailure;

  /** Creates a stable public rejection while retaining the original error as its cause. */
  constructor(failure: RuntimeStartupFailure, cause?: unknown) {
    super(failure.message, cause === undefined ? undefined : { cause });
    this.code = failure.code;
    this.failure = failure;
  }
}

/** True when an error is a classified persistent-runtime startup failure. */
export function isRuntimeStartupError(error: unknown): error is RuntimeStartupError {
  return error instanceof RuntimeStartupError;
}

/** Builds the stable failure record for a refused framework-driven reload. */
export function reloadLoopFailure(
  runtimeMode: RuntimeStartupFailure["runtimeMode"],
): RuntimeStartupFailure {
  return { code: "reload-loop", runtimeMode, message: startupMessages["reload-loop"] };
}

/** Maps vendor, capability, configuration, and fallback failures onto stable Lofi categories. */
export function classifyRuntimeStartupFailure(
  error: unknown,
  runtimeMode: RuntimeStartupFailure["runtimeMode"],
): RuntimeStartupFailure {
  const code: RuntimeStartupFailureCode =
    error instanceof IncompatibleBrowserBrokerConfigurationError
      ? "broker-incompatible"
      : error instanceof DurableStorageUnsupportedError
      ? "unsupported-capabilities"
      : error instanceof LofiConfigurationError
      ? "configuration-error"
      : "storage-startup-failed";
  return { code, runtimeMode, message: startupMessages[code] };
}

/**
 * Creates the package-owned Jazz override. It records the stable failure but
 * deliberately never confirms or reloads; the rejected createDb call remains
 * the startup boundary and recovery stays an explicit user action.
 */
export function createBrokerIncompatibilityHandler(
  runtimeMode: RuntimeStartupFailure["runtimeMode"],
  record: (failure: RuntimeStartupFailure) => void,
): IncompatibleBrowserBrokerConfigurationHandler {
  return (error) => record(classifyRuntimeStartupFailure(error, runtimeMode));
}

/** Runs one runtime startup attempt, retaining and throwing only Lofi-owned classification. */
export async function runRuntimeStartup<T>(
  runtimeMode: RuntimeStartupFailure["runtimeMode"],
  start: () => Promise<T>,
  record: (failure: RuntimeStartupFailure) => void,
): Promise<T> {
  try {
    return await start();
  } catch (error) {
    if (error instanceof RuntimeStartupError) throw error;
    const failure = classifyRuntimeStartupFailure(error, runtimeMode);
    record(failure);
    throw new RuntimeStartupError(failure, error);
  }
}

/** Performs the explicit navigation required after closing incompatible app tabs. */
export function reloadAfterRuntimeStartupFailure(
  reload: () => void = () => globalThis.location.reload(),
): void {
  reload();
}
