/**
 * Opt-in helpers for turning file launches or ordinary picker files into
 * bounded, validated import drafts.
 *
 * @module
 */

import {
  type InstalledAppLaunchConsumer,
  type InstalledAppLaunchQueue,
  installInstalledAppLaunchQueueConsumer,
} from "./launch-handler.ts";

export type { InstalledAppLaunchConsumer, InstalledAppLaunchQueue } from "./launch-handler.ts";

/** A minimal read-only file handle delivered by an installed-app launch. */
export type InstalledAppFileHandle = {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
};

/** Explicit MIME-to-extension allow-list shared by the manifest and importer. */
export type FileImportAccept = Readonly<Record<string, readonly string[]>>;

/** Stable rejection that never contains a received file name or content. */
export type FileImportIssue =
  | "empty-selection"
  | "too-many-files"
  | "invalid-handle"
  | "unreadable-file"
  | "invalid-name"
  | "unsupported-type"
  | "unsupported-extension"
  | "file-too-large"
  | "selection-too-large"
  | "invalid-content";

/** One parsed file ready for product-owned preview, but not persistence. */
export type FileImportDraft<Parsed> = {
  readonly file: File;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly parsed: Parsed;
};

/** Accepted import drafts or a value-free rejection. */
export type FileImportResult<Parsed> =
  | { ok: true; drafts: readonly FileImportDraft<Parsed>[] }
  | { ok: false; issue: FileImportIssue; index?: number };

/** Limits and product-owned content parser for preparing import drafts. */
export type PrepareFileImportOptions<Parsed> = {
  /** Exact MIME types and lowercase extensions the product understands. */
  accept: FileImportAccept;
  /** Maximum number of files accepted in one user action. */
  maxFiles: number;
  /** Maximum bytes accepted for any one file. */
  maxFileBytes: number;
  /** Maximum bytes accepted across the selection. Defaults to maxFiles * maxFileBytes. */
  maxTotalBytes?: number;
  /** Parse and validate file content for preview. Throw to reject it. */
  parse(file: File): Parsed | Promise<Parsed>;
};

/** Options for consuming installed file launches into preview-only drafts. */
export type InstallFileLaunchConsumerOptions<Parsed> = PrepareFileImportOptions<Parsed> & {
  /** Override the browser queue for tests. */
  queue?: InstalledAppLaunchQueue;
  /** Receives only fully validated drafts. The product must still ask before persistence. */
  onDrafts(drafts: readonly FileImportDraft<Parsed>[]): void;
  /** Receives a value-free reason for a rejected launch. */
  onRejected?(issue: FileImportIssue, index?: number): void;
};

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateOptions<Parsed>(options: PrepareFileImportOptions<Parsed>): {
  accept: Map<string, Set<string>>;
  maxTotalBytes: number;
} {
  if (!isPositiveSafeInteger(options.maxFiles) || !isPositiveSafeInteger(options.maxFileBytes)) {
    throw new TypeError("file import limits must be positive safe integers");
  }
  const maxTotalBytes = options.maxTotalBytes ?? options.maxFiles * options.maxFileBytes;
  if (!isPositiveSafeInteger(maxTotalBytes)) {
    throw new TypeError("file import total limit must be a positive safe integer");
  }
  const accept = new Map<string, Set<string>>();
  for (const [type, extensions] of Object.entries(options.accept)) {
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)) {
      throw new TypeError("file import MIME types must be explicit lowercase types");
    }
    if (!Array.isArray(extensions) || extensions.length === 0) {
      throw new TypeError("each file import MIME type needs extensions");
    }
    const normalized = new Set<string>();
    for (const extension of extensions) {
      if (!/^\.[a-z0-9][a-z0-9.+_-]*$/.test(extension)) {
        throw new TypeError("file import extensions must be explicit lowercase dot extensions");
      }
      normalized.add(extension);
    }
    if (normalized.size !== extensions.length) {
      throw new TypeError("file import extensions must not repeat within a MIME type");
    }
    accept.set(type, normalized);
  }
  if (accept.size === 0) throw new TypeError("file import accept list must not be empty");
  return { accept, maxTotalBytes };
}

function validName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== "." && name !== ".." &&
    !/[\\/]/.test(name) &&
    ![...name].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    });
}

function hasAcceptedExtension(name: string, extensions: ReadonlySet<string>): boolean {
  const normalized = name.toLowerCase();
  return [...extensions].some((extension) =>
    normalized.length > extension.length && normalized.endsWith(extension)
  );
}

function isInstalledFileHandle(value: unknown): value is InstalledAppFileHandle {
  return value !== null && typeof value === "object" &&
    (value as { kind?: unknown }).kind === "file" &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { getFile?: unknown }).getFile === "function";
}

async function readInput(input: File | InstalledAppFileHandle): Promise<
  | { ok: true; file: File }
  | { ok: false; issue: FileImportIssue }
> {
  if (input instanceof File) return { ok: true, file: input };
  if (!isInstalledFileHandle(input)) return { ok: false, issue: "invalid-handle" };
  if (!validName(input.name)) return { ok: false, issue: "invalid-name" };
  try {
    const file = await input.getFile();
    if (!(file instanceof File)) return { ok: false, issue: "invalid-handle" };
    if (file.name !== input.name) return { ok: false, issue: "invalid-name" };
    return { ok: true, file };
  } catch {
    return { ok: false, issue: "unreadable-file" };
  }
}

/**
 * Validate picker files or installed-app handles and parse them into drafts.
 *
 * The function performs no writes. Keep the returned drafts in transient UI
 * state, show a preview, and persist only after an explicit user confirmation.
 */
export async function prepareFileImportDrafts<Parsed>(
  inputs: readonly (File | InstalledAppFileHandle)[],
  options: PrepareFileImportOptions<Parsed>,
): Promise<FileImportResult<Parsed>> {
  const configured = validateOptions(options);
  if (inputs.length === 0) return { ok: false, issue: "empty-selection" };
  if (inputs.length > options.maxFiles) return { ok: false, issue: "too-many-files" };

  const drafts: FileImportDraft<Parsed>[] = [];
  let totalBytes = 0;
  for (const [index, input] of inputs.entries()) {
    const read = await readInput(input);
    if (!read.ok) return { ok: false, issue: read.issue, index };
    const file = read.file;
    if (!validName(file.name)) return { ok: false, issue: "invalid-name", index };
    const extensions = configured.accept.get(file.type);
    if (!extensions) return { ok: false, issue: "unsupported-type", index };
    if (!hasAcceptedExtension(file.name, extensions)) {
      return { ok: false, issue: "unsupported-extension", index };
    }
    if (file.size > options.maxFileBytes) {
      return { ok: false, issue: "file-too-large", index };
    }
    totalBytes += file.size;
    if (totalBytes > configured.maxTotalBytes) {
      return { ok: false, issue: "selection-too-large", index };
    }
    let parsed: Parsed;
    try {
      parsed = await options.parse(file);
    } catch {
      return { ok: false, issue: "invalid-content", index };
    }
    drafts.push({ file, name: file.name, type: file.type, size: file.size, parsed });
  }
  return { ok: true, drafts };
}

/** Feature-detect `launchQueue` and turn file launches into validated drafts. */
export function installFileLaunchConsumer<Parsed>(
  options: InstallFileLaunchConsumerOptions<Parsed>,
): InstalledAppLaunchConsumer {
  validateOptions(options);
  let generation = 0;
  const consumer = installInstalledAppLaunchQueueConsumer({
    queue: options.queue,
    onLaunch(parameters) {
      const current = ++generation;
      const inputs = parameters.files ?? [];
      void prepareFileImportDrafts(
        inputs as unknown as readonly InstalledAppFileHandle[],
        options,
      ).then(
        (result) => {
          if (current !== generation) return;
          if (result.ok) options.onDrafts(result.drafts);
          else options.onRejected?.(result.issue, result.index);
        },
      );
    },
  });
  return {
    supported: consumer.supported,
    dispose() {
      generation++;
      consumer.dispose();
    },
  };
}
