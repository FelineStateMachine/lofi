import {
  createTestPasskey,
  passkeyCreationOptions,
  passkeyRequestOptions,
  retrieveTestPasskey,
  siblingRpId,
  verifySiblingRpRejected,
} from "./passkey-check.ts";
import { assert } from "./test-assert.ts";

const test = (globalThis as unknown as {
  Deno: { test(name: string, body: () => void | Promise<void>): void };
}).Deno.test;

function bytes(value: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(32).fill(value);
}

test("test passkey creation uses the exact origin RP ID and a discoverable credential", () => {
  const options = passkeyCreationOptions("app.example.com", bytes(1), bytes(2));
  assert(options.rp.id === "app.example.com", "creation changed the exact RP ID");
  assert(options.user.name === "lofi-device-check", "creation used an unstable test user name");
  assert(
    options.authenticatorSelection?.residentKey === "required",
    "creation did not require a discoverable credential",
  );
  assert(
    options.authenticatorSelection?.userVerification === "required",
    "creation did not require user verification",
  );
  assert(options.attestation === "none", "creation requested unnecessary attestation");
});

test("test passkey retrieval is bound to the exact RP ID and remains discoverable", () => {
  const options = passkeyRequestOptions("app.example.com", bytes(4));
  assert(options.rpId === "app.example.com", "retrieval changed the exact RP ID");
  assert(
    options.allowCredentials === undefined,
    "retrieval stopped exercising discoverable credential selection",
  );
  assert(options.userVerification === "required", "retrieval did not require user verification");
});

test("sibling RP check never falls back to a parent RP ID", () => {
  assert(
    siblingRpId("2c6d.n.zip") === "invalid-sibling.n.zip",
    "nzip sibling check used the wrong RP ID",
  );
  assert(
    siblingRpId("lofi-dev.example.deno.net") === "invalid-sibling.example.deno.net",
    "Deno sibling check used the wrong RP ID",
  );
});

test("creation persists only the opaque credential ID", async () => {
  const writes: Array<[string, string]> = [];
  const storage = {
    getItem: () => null,
    setItem: (key: string, value: string) => writes.push([key, value]),
  } as unknown as Storage;
  const credentials = {
    create: () => Promise.resolve({ rawId: bytes(5).buffer } as unknown as Credential),
  } as unknown as CredentialsContainer;

  const result = await createTestPasskey({ credentials, storage, rpId: "app.example.com" });

  assert(result.status === "created", "creation did not report success");
  assert(writes.length === 1, "creation persisted more than one value");
  assert(writes[0][0] === "lofi:device-check:credential-id", "creation used the wrong key");
  assert(writes[0][1] === "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU", "wrong ID");
});

test("retrieval uses discoverable selection and verifies the stored ID", async () => {
  let request: CredentialRequestOptions | undefined;
  const storage = {
    getItem: () => "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgY",
  } as unknown as Storage;
  const credentials = {
    get: (options: CredentialRequestOptions) => {
      request = options;
      return Promise.resolve({ rawId: bytes(6).buffer } as unknown as Credential);
    },
  } as unknown as CredentialsContainer;

  const result = await retrieveTestPasskey({ credentials, storage, rpId: "app.example.com" });

  assert(result.status === "retrieved", "retrieval did not report success");
  assert(request?.publicKey?.rpId === "app.example.com", "retrieval changed the RP ID");
  assert(request?.publicKey?.allowCredentials === undefined, "retrieval used an allow list");
});

test("sibling RP evidence requires a browser SecurityError", async () => {
  let request: CredentialRequestOptions | undefined;
  const credentials = {
    get: (options: CredentialRequestOptions) => {
      request = options;
      return Promise.reject(new DOMException("not exposed", "SecurityError"));
    },
  } as unknown as CredentialsContainer;

  const result = await verifySiblingRpRejected({ credentials, rpId: "app.example.com" });

  assert(result.status === "sibling-rejected", "sibling rejection was not accepted");
  assert(request?.publicKey?.rpId === "invalid-sibling.example.com", "wrong sibling RP ID");
});
