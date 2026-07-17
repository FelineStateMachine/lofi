/**
 * A Playwright helper that installs a Chrome DevTools Protocol virtual
 * authenticator on a page, so WebAuthn enroll/authenticate flows and RP-ID
 * isolation can be exercised headless without a physical device.
 *
 * CDP virtual authenticators do **not** reliably model the WebAuthn PRF
 * extension, so this helper is for enroll / authenticate / RP-ID coverage only.
 * PRF derivation is feature-detected in the runtime and must be validated on a
 * real device; do not assert PRF results against a virtual authenticator.
 *
 * @module
 */

import type { Page } from "npm:playwright@1.61.1";

/** Options for {@link withVirtualAuthenticator}. */
export interface VirtualAuthenticatorOptions {
  /** CTAP2 (`ctap2`) or legacy U2F (`u2f`); defaults to `ctap2`. */
  readonly protocol?: "ctap2" | "u2f";
  /** The credential transport reported to the page; defaults to `internal`. */
  readonly transport?: "usb" | "nfc" | "ble" | "cable" | "internal";
  /** Whether the authenticator stores resident (discoverable) keys; defaults to true. */
  readonly hasResidentKey?: boolean;
  /** Whether the authenticator can perform user verification; defaults to true. */
  readonly hasUserVerification?: boolean;
  /** Whether the simulated user is already verified; defaults to true. */
  readonly isUserVerified?: boolean;
  /** Whether presence/verification is auto-satisfied without a prompt; defaults to true. */
  readonly automaticPresenceSimulation?: boolean;
}

/** Serializable CDP credential used to copy one virtual passkey between browser profiles. */
export interface VirtualAuthenticatorCredential {
  readonly credentialId: string;
  readonly isResidentCredential: boolean;
  readonly rpId?: string;
  readonly privateKey: string;
  readonly userHandle?: string;
  readonly signCount: number;
  readonly largeBlob?: string;
}

/** A handle to an installed virtual authenticator; call {@link dispose} to remove it. */
export interface VirtualAuthenticatorHandle {
  /** The CDP-assigned id of the virtual authenticator. */
  readonly authenticatorId: string;
  /** Return credentials from this virtual authenticator. Treat private keys as test secrets. */
  credentials(): Promise<VirtualAuthenticatorCredential[]>;
  /** Install a previously exported virtual credential in this test profile. */
  addCredential(credential: VirtualAuthenticatorCredential): Promise<void>;
  /** Remove the virtual authenticator and detach the CDP session. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Install a CDP virtual authenticator on `page` and return a handle that removes
 * it on {@link VirtualAuthenticatorHandle.dispose}. Defaults model an internal,
 * resident, user-verifying platform authenticator that auto-satisfies presence.
 */
export async function withVirtualAuthenticator(
  page: Page,
  options: VirtualAuthenticatorOptions = {},
): Promise<VirtualAuthenticatorHandle> {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable", { enableUI: true });
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: options.protocol ?? "ctap2",
      transport: options.transport ?? "internal",
      hasResidentKey: options.hasResidentKey ?? true,
      hasUserVerification: options.hasUserVerification ?? true,
      isUserVerified: options.isUserVerified ?? true,
      automaticPresenceSimulation: options.automaticPresenceSimulation ?? true,
    },
  });

  let disposed = false;
  return {
    authenticatorId,
    async credentials(): Promise<VirtualAuthenticatorCredential[]> {
      const result = await session.send("WebAuthn.getCredentials", { authenticatorId }) as {
        credentials: VirtualAuthenticatorCredential[];
      };
      return result.credentials;
    },
    async addCredential(credential: VirtualAuthenticatorCredential): Promise<void> {
      await session.send("WebAuthn.addCredential", { authenticatorId, credential });
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await session.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      await session.detach();
    },
  };
}
