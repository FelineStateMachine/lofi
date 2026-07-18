import type { ReactNode } from "react";
import { useReducer, useRef, useState } from "react";

// A last-write-wins register per task id, replicated between two simulated
// devices. Offline writes queue in an outbox; reconnect merges. Ported from
// the original vanilla implementation in the lofi-site landing page.

type Task = { id: string; text: string; done: boolean; ts: number; origin: DeviceId };
type DeviceId = "A" | "B";
type Device = { store: Map<string, Task>; outbox: string[] };
type Rig = { seq: number; online: boolean; dev: Record<DeviceId, Device> };

const OTHER: Record<DeviceId, DeviceId> = { A: "B", B: "A" };

function seedRig(): Rig {
  const rig: Rig = {
    seq: 0,
    online: true,
    dev: {
      A: { store: new Map(), outbox: [] },
      B: { store: new Map(), outbox: [] },
    },
  };
  const seeds: Array<[string, boolean]> = [
    ["Water the ferns", true],
    ["Repot the monstera", false],
    ["Order more perlite", false],
  ];
  for (const [text, done] of seeds) {
    const task: Task = { id: `seed-${rig.seq}`, text, done, ts: rig.seq++, origin: "A" };
    rig.dev.A.store.set(task.id, { ...task });
    rig.dev.B.store.set(task.id, { ...task });
  }
  return rig;
}

function DeviceFrame(props: {
  which: DeviceId;
  name: string;
  rig: Rig;
  onAdd: (which: DeviceId, text: string) => void;
  onToggle: (which: DeviceId, task: Task) => void;
}): ReactNode {
  const { which, name, rig, onAdd, onToggle } = props;
  const [draft, setDraft] = useState("");
  const device = rig.dev[which];
  const tasks = [...device.store.values()].sort((a, b) => a.ts - b.ts);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onAdd(which, text);
  };

  return (
    <div className={`dev dev--${which.toLowerCase()}`}>
      <p className="dev-name">{name}</p>
      <div className="dev-body">
        <div className="add">
          <input
            type="text"
            value={draft}
            placeholder="Add a task…"
            aria-label={`Add a task on ${name.toLowerCase()}`}
            maxLength={42}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button type="button" aria-label={`Add task on ${name.toLowerCase()}`} onClick={submit}>
            <span>+</span>
          </button>
        </div>
        <ul className="tasks">
          {tasks.length === 0 && <li className="tasks-empty">Nothing here yet.</li>}
          {tasks.map((task) => (
            <li
              key={task.id}
              className={[
                task.done ? "is-done" : "",
                device.outbox.includes(task.id) ? "is-pending" : "",
              ].join(" ").trim()}
            >
              <button
                type="button"
                className="tick"
                aria-pressed={task.done}
                aria-label={`${task.done ? "Mark not done" : "Mark done"}: ${task.text}`}
                onClick={() => onToggle(which, task)}
              >
                <svg viewBox="0 0 10 10" aria-hidden="true">
                  <path
                    d="M1 5l2.6 3L9 1.5"
                    fill="none"
                    stroke="#18231f"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <span className="task-text">{task.text}</span>
              <span className="pending-dot" title="Not yet synced" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function SyncDemo(): ReactNode {
  const rigRef = useRef<Rig | null>(null);
  rigRef.current ??= seedRig();
  const rig = rigRef.current;
  const wireRef = useRef<HTMLDivElement>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const stamp = () => Date.now() * 1000 + rig.seq++;
  const uid = () => `t${rig.seq++}-${Math.random().toString(36).slice(2, 7)}`;

  const apply = (target: DeviceId, rec: Task) => {
    const have = rig.dev[target].store.get(rec.id);
    if (!have || rec.ts > have.ts) rig.dev[target].store.set(rec.id, { ...rec });
  };

  const pulse = () => {
    const wire = wireRef.current;
    if (!wire) return;
    wire.classList.remove("is-flowing");
    void wire.offsetWidth; /* restart the animation */
    wire.classList.add("is-flowing");
  };

  const flush = (source: DeviceId) => {
    const ids = rig.dev[source].outbox.splice(0);
    if (ids.length === 0) return;
    const records = ids
      .map((id) => rig.dev[source].store.get(id))
      .filter((rec): rec is Task => rec !== undefined);
    pulse();
    /* let the change visibly travel the wire before the other device shows it */
    setTimeout(() => {
      for (const rec of records) apply(OTHER[source], rec);
      rerender();
    }, 260);
  };

  const write = (source: DeviceId, rec: Task) => {
    rig.dev[source].store.set(rec.id, { ...rec });
    rig.dev[source].outbox.push(rec.id);
    if (rig.online) flush(source);
    rerender();
  };

  const onAdd = (which: DeviceId, text: string) => {
    write(which, { id: uid(), text, done: false, ts: stamp(), origin: which });
  };

  const onToggle = (which: DeviceId, task: Task) => {
    write(which, { ...task, done: !task.done, ts: stamp(), origin: which });
  };

  const onNetChange = (online: boolean) => {
    rig.online = online;
    if (online) {
      /* both sides push what they buffered; the register converges either way */
      flush("A");
      flush("B");
    }
    rerender();
  };

  const pending = rig.dev.A.outbox.length + rig.dev.B.outbox.length;
  const statusText = rig.online
    ? "Synced"
    : pending > 0
    ? "Offline — writing locally"
    : "Offline";

  return (
    <div className={`demo-shell${rig.online ? "" : " is-offline"}`}>
      <div className="demo-bar">
        <p className="demo-status">
          <span className="led" />
          <span>{statusText}</span>
        </p>
        <label className="switch">
          <input
            type="checkbox"
            checked={rig.online}
            onChange={(event) => onNetChange(event.target.checked)}
          />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          <span>Network</span>
        </label>
      </div>

      <div className="rig">
        <DeviceFrame which="A" name="This phone" rig={rig} onAdd={onAdd} onToggle={onToggle} />
        <div className="wire" ref={wireRef} aria-hidden="true">
          <div className="wire-line" />
          <div className="wire-flow" />
          <div className={`wire-badge${!rig.online && pending > 0 ? " is-on" : ""}`}>
            {pending} {pending === 1 ? "change waiting" : "changes waiting"}
          </div>
        </div>
        <DeviceFrame
          which="B"
          name="Your other device"
          rig={rig}
          onAdd={onAdd}
          onToggle={onToggle}
        />
      </div>

      <p className="demo-foot">
        A simulation, drawn to the same model (not a live Jazz session). For the real one, and for
        the part where you close the laptop and it is all still there tomorrow:{" "}
        <code>deno task dev</code>.
      </p>
    </div>
  );
}
