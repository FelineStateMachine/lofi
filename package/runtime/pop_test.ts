// Client proof-of-possession contract: signatures match the cross-repo
// fixtures byte for byte, the device keypair persists per app, and the
// pre-connect exchange yields the token URL or degrades to null.
import {
  completePopExchange,
  exportDevicePublicKey,
  getOrCreatePopKeyPair,
  memoryPopKeyStore,
  popMessage,
  signPopMessage,
} from "./pop.ts";
import { assert } from "./test-assert.ts";

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

type PopFixtures = {
  privateJwk: JsonWebKey;
  spki: string;
  appId: string;
  ticketId: string;
  nonce: string;
  signature: string;
};

async function loadFixtures(): Promise<PopFixtures> {
  return JSON.parse(
    await Deno.readTextFile(new URL("../testdata/pop-fixtures.json", import.meta.url)),
  ) as PopFixtures;
}

Deno.test("signatures conform to the node's fixture vectors", async () => {
  const fixtures = await loadFixtures();
  const message = popMessage(fixtures.appId, fixtures.ticketId, fixtures.nonce);

  // The fixture's own signature verifies under its public key — the message
  // bytes this client builds are the bytes the node verifies.
  const publicKey = await crypto.subtle.importKey(
    "spki",
    fromBase64Url(fixtures.spki).buffer as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromBase64Url(fixtures.signature).buffer as ArrayBuffer,
      message.buffer as ArrayBuffer,
    ),
    "the fixture signature must verify over this client's message bytes",
  );

  // A signature this client produces with the fixture's private key verifies
  // the same way — signing and verification agree end to end.
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    fixtures.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signed = await signPopMessage(
    { privateKey, publicKey } as CryptoKeyPair,
    message,
  );
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      fromBase64Url(signed).buffer as ArrayBuffer,
      message.buffer as ArrayBuffer,
    ),
    "a client-produced signature must verify under the fixture key",
  );
});

Deno.test("the device keypair persists per app and exports its public half", async () => {
  const store = memoryPopKeyStore();
  const first = await getOrCreatePopKeyPair("app-a", store);
  const again = await getOrCreatePopKeyPair("app-a", store);
  assert(first.privateKey === again.privateKey, "the same app must reuse its keypair");
  const other = await getOrCreatePopKeyPair("app-b", store);
  assert(other.privateKey !== first.privateKey, "apps must not share keypairs");
  assert(first.privateKey.extractable === false, "the signing key must be non-extractable");
  const exported = await exportDevicePublicKey(first);
  assert(
    exported.alg === "ES256" && exported.spki.length > 80,
    "the public half must export as base64url SPKI",
  );
});

Deno.test("the exchange yields the token URL and degrades to null", async () => {
  const store = memoryPopKeyStore();
  const keyPair = await getOrCreatePopKeyPair("app-x", store);
  const exported = await exportDevicePublicKey(keyPair);

  const requests: string[] = [];
  const respondingFetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/pop/challenge")) {
      return Response.json({ v: 1, id: "chal-1", nonce: "nonce-1", expiresIn: 120 });
    }
    if (url.endsWith("/pop/answer")) {
      const body = JSON.parse(String(init?.body)) as { id: string; sig: string };
      // Verify the signature exactly as the node would.
      const publicKey = await crypto.subtle.importKey(
        "spki",
        fromBase64Url(exported.spki).buffer as ArrayBuffer,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const valid = body.id === "chal-1" && await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        fromBase64Url(body.sig).buffer as ArrayBuffer,
        popMessage("app-x", "ticket-1", "nonce-1").buffer as ArrayBuffer,
      );
      return valid
        ? Response.json({ v: 1, connect: "tok-abc", expiresIn: 86400 })
        : Response.json({ error: "invalid_ticket" }, { status: 401 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const connectUrl = await completePopExchange({
    serverUrl: "http://node/t/secret",
    appId: "app-x",
    ticketId: "ticket-1",
    keyPair,
    fetcher: respondingFetcher,
  });
  assert(connectUrl === "http://node/t/secret/c/tok-abc", `unexpected url: ${connectUrl}`);
  assert(requests.length === 2, "the exchange is exactly two requests");

  // A node without the exchange (404) degrades to null, as does a refusal.
  const failingFetcher =
    (() => Promise.resolve(new Response("not found", { status: 404 }))) as typeof fetch;
  assert(
    await completePopExchange({
      serverUrl: "http://node/t/secret",
      appId: "app-x",
      ticketId: "ticket-1",
      keyPair,
      fetcher: failingFetcher,
    }) === null,
    "a missing exchange must degrade to null",
  );
});
