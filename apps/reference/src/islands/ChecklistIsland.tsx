import { useEffect, useState } from "preact/hooks";
import type { ChecklistTask } from "../_lofi/checklist-store.ts";
import { settleUiMutation } from "../_lofi/ui-mutation.ts";
import { useChecklist } from "../_lofi/use-checklist.ts";

export interface ChecklistIslandProps {
  label: string;
}

type ChecklistRowProps = {
  task: ChecklistTask;
  update(id: string, text: string): Promise<void>;
  setCompleted(id: string, completed: boolean): Promise<void>;
  remove(id: string): Promise<void>;
};

function ChecklistRow({ task, update, setCompleted, remove }: ChecklistRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.text);
  const editId = `edit-${task.id}`;

  useEffect(() => {
    if (!editing) setDraft(task.text);
  }, [editing, task.text]);

  return (
    <li class={task.completed ? "task task-complete" : "task"} data-task-id={task.id}>
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
      {editing
        ? (
          <form
            class="edit-form"
            onSubmit={(event) => {
              event.preventDefault();
              const next = draft.trim();
              if (!next) return;
              setEditing(false);
              void settleUiMutation(update(task.id, next));
            }}
          >
            <label class="visually-hidden" for={editId}>Edit {task.text}</label>
            <input
              id={editId}
              value={draft}
              onInput={(event) => setDraft(event.currentTarget.value)}
              autocomplete="off"
            />
            <button type="submit" aria-label={`Save ${task.text}`}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        )
        : (
          <div class="task-actions">
            <button
              type="button"
              aria-label={`Edit ${task.text}`}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              class="button-danger"
              aria-label={`Delete ${task.text}`}
              onClick={() => void settleUiMutation(remove(task.id))}
            >
              Delete
            </button>
          </div>
        )}
    </li>
  );
}

export default function ChecklistIsland({ label }: ChecklistIslandProps) {
  const checklist = useChecklist();
  const [text, setText] = useState("");
  const inputId = `task-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;

  return (
    <section class="island" data-island={label}>
      <header>
        <p class="eyebrow">{label}</p>
        <h2>Shared checklist</h2>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = text.trim();
          if (!next) return;
          setText("");
          void settleUiMutation(checklist.create(next));
        }}
      >
        <label for={inputId}>New item</label>
        <div class="composer">
          <input
            id={inputId}
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
            autocomplete="off"
          />
          <button type="submit">Add from {label}</button>
        </div>
      </form>
      <p class="state" role="status">
        {checklist.status === "loading" && "Opening persistent storage…"}
        {checklist.status === "error" && `Write failed: ${checklist.error}`}
        {checklist.status === "ready" &&
          `${checklist.tasks.length} item(s) · last write ${checklist.durability}`}
      </p>
      <ul aria-label={`${label} checklist`}>
        {checklist.tasks.map((task) => (
          <ChecklistRow
            key={task.id}
            task={task}
            update={checklist.update}
            setCompleted={checklist.setCompleted}
            remove={checklist.remove}
          />
        ))}
      </ul>
    </section>
  );
}
