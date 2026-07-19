/**
 * Plaintext padding for encrypted columns: payloads are padded to bucket
 * lengths before sealing, so the stored ciphertext reveals a size class
 * rather than an exact content length.
 *
 * The bucket schedule is Padmé with a floor: every payload up to the floor
 * pads to the floor (all short scalars share one indistinguishable class),
 * and larger payloads round up to a Padmé bucket, which bounds overhead at
 * roughly 12% while leaking only O(log log n) bits of length.
 *
 * The padded form is self-describing — a 4-byte big-endian payload length,
 * the payload, then zero fill — so unpadding needs no knowledge of the
 * schedule. The schedule can therefore evolve without a format version bump:
 * values padded under an older schedule still open.
 *
 * @module
 */

/** Byte length of the payload-length prefix inside a padded plaintext. */
export const PADDING_PREFIX_LENGTH = 4;

/** Every padded plaintext is at least this long. */
export const PADDING_FLOOR = 64;

/**
 * The bucket length for a raw length `n` (prefix included): the floor for
 * short payloads, a Padmé bucket above it.
 */
export function paddedLength(n: number): number {
  if (n <= PADDING_FLOOR) return PADDING_FLOOR;
  const exponent = Math.floor(Math.log2(n));
  const secondExponent = Math.floor(Math.log2(exponent)) + 1;
  const step = 2 ** (exponent - secondExponent);
  return Math.ceil(n / step) * step;
}

/**
 * Pads a payload to its bucket: 4-byte big-endian length, payload, zero fill.
 */
export function padPayload(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffff_ffff) {
    throw new RangeError("payload exceeds the maximum padded size");
  }
  const total = paddedLength(PADDING_PREFIX_LENGTH + payload.length);
  const padded = new Uint8Array(total);
  new DataView(padded.buffer).setUint32(0, payload.length);
  padded.set(payload, PADDING_PREFIX_LENGTH);
  return padded;
}

/**
 * Recovers the payload from a padded plaintext. Throws `RangeError` when the
 * declared length cannot fit — the caller maps this to its corrupt-value
 * error, though under an AEAD it indicates a codec bug rather than tampering.
 */
export function unpadPayload(padded: Uint8Array): Uint8Array {
  if (padded.length < PADDING_PREFIX_LENGTH) {
    throw new RangeError("padded plaintext is shorter than its length prefix");
  }
  const length = new DataView(padded.buffer, padded.byteOffset).getUint32(0);
  if (PADDING_PREFIX_LENGTH + length > padded.length) {
    throw new RangeError("padded plaintext declares a length past its end");
  }
  return padded.slice(PADDING_PREFIX_LENGTH, PADDING_PREFIX_LENGTH + length);
}
