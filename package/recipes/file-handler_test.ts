import {
  type FileImportIssue,
  installFileLaunchConsumer,
  prepareFileImportDrafts,
} from "./file-handler.ts";
import type { InstalledAppLaunchParameters, InstalledAppLaunchQueue } from "./launch-handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const options = {
  accept: { "application/json": [".json"] },
  maxFiles: 2,
  maxFileBytes: 64,
  maxTotalBytes: 96,
  async parse(file: File) {
    const value = JSON.parse(await file.text());
    if (!value || typeof value !== "object" || typeof value.title !== "string") {
      throw new Error("invalid export");
    }
    return { title: value.title as string };
  },
} as const;

Deno.test("file import prepares parsed picker and handle drafts without persistence", async () => {
  const picker = new File(['{"title":"Picker"}'], "picker.json", {
    type: "application/json",
  });
  const handledFile = new File(['{"title":"Opened"}'], "opened.json", {
    type: "application/json",
  });
  const result = await prepareFileImportDrafts([
    picker,
    { kind: "file", name: "opened.json", getFile: () => Promise.resolve(handledFile) },
  ], options);
  assert(result.ok, `valid files failed: ${JSON.stringify(result)}`);
  assert(result.drafts.length === 2, "draft count drifted");
  assert(result.drafts[1].parsed.title === "Opened", "file content was not parsed");

  const compound = await prepareFileImportDrafts(
    [
      new File(['{"title":"Compound"}'], "notes.FIELD-NOTES.JSON", {
        type: "application/json",
      }),
    ],
    { ...options, accept: { "application/json": [".field-notes.json"] } },
  );
  assert(compound.ok, "compound case-insensitive extension was rejected");
});

Deno.test("file import rejects untrusted metadata, limits, access, and content", async () => {
  const cases: Array<[string, Parameters<typeof prepareFileImportDrafts>[0], FileImportIssue]> = [
    ["empty", [], "empty-selection"],
    [
      "count",
      [
        new File(["{}"], "a.json", { type: "application/json" }),
        new File(["{}"], "b.json", { type: "application/json" }),
        new File(["{}"], "c.json", { type: "application/json" }),
      ],
      "too-many-files",
    ],
    [
      "name",
      [new File(["{}"], "../private.json", { type: "application/json" })],
      "invalid-name",
    ],
    [
      "type",
      [new File(["{}"], "note.json", { type: "text/plain" })],
      "unsupported-type",
    ],
    [
      "extension",
      [new File(["{}"], "note.txt", { type: "application/json" })],
      "unsupported-extension",
    ],
    [
      "size",
      [new File(["x".repeat(65)], "note.json", { type: "application/json" })],
      "file-too-large",
    ],
    [
      "content",
      [new File(["{}"], "note.json", { type: "application/json" })],
      "invalid-content",
    ],
    [
      "denied",
      [{
        kind: "file",
        name: "note.json",
        getFile: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
      }],
      "unreadable-file",
    ],
  ];
  for (const [label, files, issue] of cases) {
    const result = await prepareFileImportDrafts(files, options);
    assert(!result.ok && result.issue === issue, `${label} produced ${JSON.stringify(result)}`);
  }

  const total = await prepareFileImportDrafts(
    [
      new File(['{"title":"One"}'], "one.json", { type: "application/json" }),
      new File(['{"title":"Two"}'], "two.json", { type: "application/json" }),
    ],
    { ...options, maxTotalBytes: 20 },
  );
  assert(!total.ok && total.issue === "selection-too-large", "total size bound was not enforced");
});

Deno.test("file import rejects unsafe allow-list configuration", async () => {
  const unsafe: Array<Record<string, readonly string[]>> = [
    { "application/*": [".json"] },
    { "application/json": ["json"] },
  ];
  for (const accept of unsafe) {
    let rejected = false;
    try {
      await prepareFileImportDrafts(
        [new File(["{}"], "note.json", { type: "application/json" })],
        { ...options, accept },
      );
    } catch (error) {
      rejected = error instanceof TypeError;
    }
    assert(rejected, "unsafe file allow-list passed");
  }
});

Deno.test("file launch consumer feature-detects, validates, and ignores stale async launches", async () => {
  const unsupported = installFileLaunchConsumer({
    ...options,
    onDrafts: () => {
      throw new Error("unsupported consumer ran");
    },
  });
  assert(!unsupported.supported, "missing launchQueue was reported as supported");

  let current: (parameters: InstalledAppLaunchParameters) => void = () => {};
  const queue: InstalledAppLaunchQueue = {
    setConsumer(next) {
      current = next;
    },
  };
  const received: string[] = [];
  const rejected: FileImportIssue[] = [];
  const consumer = installFileLaunchConsumer({
    ...options,
    queue,
    onDrafts: (drafts) => received.push(drafts[0].parsed.title),
    onRejected: (issue) => rejected.push(issue),
  });
  current({
    files: [{
      kind: "file",
      name: "opened.json",
      getFile: () =>
        Promise.resolve(
          new File(['{"title":"Opened"}'], "opened.json", {
            type: "application/json",
          }),
        ),
    }] as unknown as FileSystemHandle[],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(received.join() === "Opened", `launch draft was not delivered: ${received}`);
  current({ files: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(rejected.join() === "empty-selection", `empty launch produced ${rejected}`);
  consumer.dispose();
});
