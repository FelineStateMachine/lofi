import { useState } from "preact/hooks";
import "../runtime/boot.ts";
import { settleUiMutation } from "../runtime/ui-mutation.ts";
import { useNotes } from "../runtime/use-notes.ts";

export interface NotesIslandProps {
  label: string;
}

export default function NotesIsland({ label }: NotesIslandProps) {
  const state = useNotes();
  const [body, setBody] = useState("");
  const inputId = `note-${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;

  return (
    <section class="island" data-island={label}>
      <header>
        <p class="eyebrow">{label}</p>
        <h2>Shared notes</h2>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = body.trim();
          if (!next) return;
          setBody("");
          void settleUiMutation(state.add(next));
        }}
      >
        <label for={inputId}>New note</label>
        <div class="composer">
          <input
            id={inputId}
            value={body}
            onInput={(event) => setBody(event.currentTarget.value)}
            autocomplete="off"
          />
          <button type="submit">Add from {label}</button>
        </div>
      </form>
      <p class="state" role="status">
        {state.status === "loading" && "Opening persistent storage…"}
        {state.status === "error" && `Error: ${state.error}`}
        {state.status === "ready" &&
          `${state.notes.length} note(s) · last write ${state.durability}`}
      </p>
      <ul aria-label={`${label} notes`}>
        {state.notes.map((note) => <li key={note.id} data-note-id={note.id}>{note.body}</li>)}
      </ul>
      <p class="diagnostics" data-diagnostics>
        storage {state.diagnostics.storageState} · clients {state.diagnostics.activeClients}{" "}
        · consumers {state.diagnostics.activeConsumers} · subscriptions{" "}
        {state.diagnostics.activeVendorSubscriptions} · error listeners {state
          .diagnostics.activeMutationListeners}
      </p>
    </section>
  );
}
