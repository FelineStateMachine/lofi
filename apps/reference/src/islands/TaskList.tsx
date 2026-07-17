import { useState } from "preact/hooks";
import { settleUiMutation } from "@nzip/lofi";
import { useTasks } from "./use-tasks.ts";

/**
 * Author-owned starter UI. One island over one table: add a row, list rows, and
 * toggle a boolean. Replace it with your own schema and components — the
 * package-owned runtime stays the same.
 */
export default function TaskList() {
  const { status, error, durability, tasks, create, setCompleted } = useTasks();
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
        {status === "loading" && "Opening persistent storage…"}
        {status === "error" && `Write failed: ${error}`}
        {status === "ready" && `${tasks.length} item(s) · ${
          durability === "global"
            ? "synced to your account"
            : durability === "local"
            ? "saved on this device"
            : durability === "failed"
            ? "write failed"
            : "ready"
        }`}
      </p>
      <ul aria-label="Tasks">
        {tasks.map((task) => (
          <li key={task.id} class={task.completed ? "task task-complete" : "task"}>
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
          </li>
        ))}
      </ul>
    </section>
  );
}
