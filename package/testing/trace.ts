const LOCAL_FILE = 0x04034b50;
const CENTRAL_FILE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8 = new TextEncoder();
const TEXT = new TextDecoder();

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function header(length: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function endOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error("Playwright trace is not a ZIP archive");
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const input = new Blob([bytes.slice()]).stream();
  const output = input.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(output).arrayBuffer());
}

export async function readTraceArchive(path: string): Promise<Record<string, Uint8Array>> {
  const bytes = await Deno.readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOffset(bytes);
  const count = view.getUint16(end + 10, true);
  let centralOffset = view.getUint32(end + 16, true);
  const entries: Record<string, Uint8Array> = {};

  for (let index = 0; index < count; index++) {
    if (view.getUint32(centralOffset, true) !== CENTRAL_FILE) {
      throw new Error("Playwright trace has an invalid central directory");
    }
    const flags = view.getUint16(centralOffset + 8, true);
    if (flags & 1) throw new Error("Encrypted trace entries cannot be sanitized");
    const method = view.getUint16(centralOffset + 10, true);
    const compressedSize = view.getUint32(centralOffset + 20, true);
    const nameLength = view.getUint16(centralOffset + 28, true);
    const extraLength = view.getUint16(centralOffset + 30, true);
    const commentLength = view.getUint16(centralOffset + 32, true);
    const localOffset = view.getUint32(centralOffset + 42, true);
    const name = TEXT.decode(bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength));
    if (view.getUint32(localOffset, true) !== LOCAL_FILE) {
      throw new Error(`Playwright trace entry ${name} has an invalid local header`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    if (method === 0) entries[name] = compressed.slice();
    else if (method === 8) entries[name] = await inflateRaw(compressed);
    else throw new Error(`Playwright trace entry ${name} uses unsupported compression ${method}`);
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function writeTraceArchive(entries: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const [name, contents] of Object.entries(entries)) {
    const nameBytes = UTF8.encode(name);
    const checksum = crc32(contents);
    const local = header(30);
    local.view.setUint32(0, LOCAL_FILE, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint32(14, checksum, true);
    local.view.setUint32(18, contents.length, true);
    local.view.setUint32(22, contents.length, true);
    local.view.setUint16(26, nameBytes.length, true);
    localParts.push(local.bytes, nameBytes, contents);

    const central = header(46);
    central.view.setUint32(0, CENTRAL_FILE, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint32(16, checksum, true);
    central.view.setUint32(20, contents.length, true);
    central.view.setUint32(24, contents.length, true);
    central.view.setUint16(28, nameBytes.length, true);
    central.view.setUint32(42, localOffset, true);
    centralParts.push(central.bytes, nameBytes);
    localOffset += local.bytes.length + nameBytes.length + contents.length;
  }

  const central = concatenate(centralParts);
  const end = header(22);
  end.view.setUint32(0, END_OF_CENTRAL_DIRECTORY, true);
  end.view.setUint16(8, Object.keys(entries).length, true);
  end.view.setUint16(10, Object.keys(entries).length, true);
  end.view.setUint32(12, central.length, true);
  end.view.setUint32(16, localOffset, true);
  return concatenate([...localParts, central, end.bytes]);
}

/** Sanitize every text entry in the intentionally snapshot-free trace archive. */
export async function sanitizeTraceArchive(
  path: string,
  redact: (value: string) => string,
): Promise<void> {
  const entries = await readTraceArchive(path);
  const sanitized: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(entries)) {
    sanitized[name] = UTF8.encode(redact(TEXT.decode(bytes)));
  }
  await Deno.writeFile(path, writeTraceArchive(sanitized));
}
