import { useState } from "preact/hooks";
import { settleUiMutation } from "@nzip/lofi";
import {
  type BootProgress,
  Notices,
  useBootProgress,
  usePendingWrites,
  useSyncStatus,
} from "@nzip/lofi/preact";
import { type Task, useTasks } from "./use-tasks.ts";

// A cold first visit waits on the engine download, not on storage; name the
// wait it is actually in, with byte progress while the download runs.
function loadingLabel(boot: BootProgress): string {
  if (boot.phase !== "downloading") return "Opening persistent storage…";
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  return boot.totalBytes === null
    ? `Downloading the app · ${mb(boot.loadedBytes)} MB…`
    : `Downloading the app · ${mb(boot.loadedBytes)} of ${mb(boot.totalBytes)} MB…`;
}

/**
 * Author-owned starter UI. One island over one table: add a row through a
 * verb with effects, list rows with per-row sync badges, and toggle a
 * boolean. Replace it with your own schema and components — the
 * package-owned runtime stays the same.
 */
export default function TaskList() {
  const { status, error, durability, tasks, failureKind, create, setCompleted } = useTasks();
  const pending = usePendingWrites();
  const boot = useBootProgress();
  const [text, setText] = useState("");

  return (
    <section id="tasks" class="island" data-island="tasks">
      <header>
        <p class="eyebrow">Local-first</p>
        <h2>Example Island: Tasks</h2>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = text.trim();
          if (!next) return;
          setText("");
          // The verb's handle is thenable: settled here at saved, while the
          // sync fate and its effects continue in the background.
          void settleUiMutation(create(next));
        }}
      >
        <label for="new-task">New task</label>
        <div class="composer">
          <input
            id="new-task"
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
            autocomplete="off"
          />
          <button type="submit">Add</button>
        </div>
      </form>
      <p class="state" role="status">
        {status === "loading" && loadingLabel(boot)}
        {status === "error" &&
          `${failureKind === "read" ? "Read failed" : "Write failed"}: ${error}`}
        {status === "ready" && `${tasks.length} item(s) · ${
          durability === "global"
            ? "synced to your account"
            : durability === "local"
            ? "saved on this device"
            : durability === "failed"
            ? "write declined"
            : "ready"
        }`}
      </p>
      {pending.count > 0 && (
        <p class="state" data-pending-writes={pending.count}>
          {pending.count} change{pending.count === 1 ? "" : "s"} waiting to sync
        </p>
      )}
      <Notices />
      <ul aria-label="Tasks">
        {tasks.map((task) => <TaskItem key={task.id} task={task} setCompleted={setCompleted} />)}
      </ul>
    </section>
  );
}

function TaskItem(
  { task, setCompleted }: {
    task: Task;
    setCompleted: (id: string, completed: boolean) => PromiseLike<unknown>;
  },
) {
  const syncStatus = useSyncStatus(task);
  return (
    <li class={task.completed ? "task task-complete" : "task"}>
      <label class="task-toggle">
        <input
          type="checkbox"
          checked={task.completed}
          aria-label={`Complete ${task.text}`}
          onChange={(event) =>
            void settleUiMutation(setCompleted(task.id, event.currentTarget.checked))}
        />
        <span>{task.text}</span>
      </label>
      {syncStatus !== "synced" && (
        <span class="state" data-sync-status={syncStatus}>
          {syncStatus === "waiting" ? "waiting to sync" : "declined"}
        </span>
      )}
    </li>
  );
}
