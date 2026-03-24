import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Check, Pause, Play, RotateCcw, Settings, Square, Trash2, X } from "lucide-react";
import { createTask, deleteTask, getTasks, initSchema, toggleTask, type Task } from "./lib/db";

type PomodoroTick = {
  remaining_ms: number;
  is_running: boolean;
  is_break: boolean;
};

type PomodoroSettings = {
  focus_minutes: number;
  break_minutes: number;
  is_break: boolean;
};

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HEATMAP_MONTHS = 18;

function formatTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function monthLabel(date: Date): string {
  return date.toLocaleString(undefined, { month: "long", year: "numeric" });
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function mondayIndex(jsDay: number): number {
  return (jsDay + 6) % 7;
}

function heatIntensity(count: number): string {
  if (count <= 0) return "bg-zinc-800/70";
  if (count === 1) return "bg-emerald-900/80";
  if (count === 2) return "bg-emerald-700/80";
  if (count === 3) return "bg-emerald-500/80";
  return "bg-emerald-300/90";
}

function buildMonthGrid(viewMonth: Date, completedByDay: Map<number, number>) {
  const firstDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const lastDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
  const firstOffset = mondayIndex(firstDay.getDay());
  const gridStart = new Date(firstDay);
  gridStart.setDate(firstDay.getDate() - firstOffset);
  const lastOffset = 6 - mondayIndex(lastDay.getDay());
  const gridEnd = new Date(lastDay);
  gridEnd.setDate(lastDay.getDate() + lastOffset);

  const allDays: Array<{ ts: number; inMonth: boolean; count: number }> = [];
  const current = new Date(gridStart);
  while (current <= gridEnd) {
    const ts = startOfDay(current.getTime());
    allDays.push({
      ts,
      inMonth: current.getMonth() === viewMonth.getMonth() && current.getFullYear() === viewMonth.getFullYear(),
      count: completedByDay.get(ts) ?? 0,
    });
    current.setDate(current.getDate() + 1);
  }

  const columns: Array<Array<{ ts: number; inMonth: boolean; count: number }>> = [];
  for (let i = 0; i < allDays.length; i += 7) columns.push(allDays.slice(i, i + 7));
  return columns;
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTitle, setNewTitle] = useState("");
  const [remainingMs, setRemainingMs] = useState(25 * 60 * 1000);
  const [isRunning, setIsRunning] = useState(false);
  const [isBreak, setIsBreak] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [focusMinutes, setFocusMinutes] = useState(25);
  const [breakMinutes, setBreakMinutes] = useState(5);
  const [heatmapScrollEl, setHeatmapScrollEl] = useState<HTMLDivElement | null>(null);

  async function refreshTasks() {
    setTasks(await getTasks());
  }

  useEffect(() => {
    let unlistenTick: UnlistenFn | null = null;
    let unlistenFinish: UnlistenFn | null = null;

    (async () => {
      try {
        await initSchema();
        await refreshTasks();
        const initial = await invoke<PomodoroTick>("pomodoro_get");
        setRemainingMs(initial.remaining_ms);
        setIsRunning(initial.is_running);
        setIsBreak(initial.is_break);

        const settings = await invoke<PomodoroSettings>("pomodoro_get_settings");
        setFocusMinutes(settings.focus_minutes);
        setBreakMinutes(settings.break_minutes);
        setIsBreak(settings.is_break);

        unlistenTick = await listen<PomodoroTick>("pomodoro:tick", (event) => {
          setRemainingMs(event.payload.remaining_ms);
          setIsRunning(event.payload.is_running);
          setIsBreak(event.payload.is_break);
        });

        unlistenFinish = await listen("pomodoro:finished", async () => {
          let granted = await isPermissionGranted();
          if (!granted) {
            granted = (await requestPermission()) === "granted";
          }
          if (granted) {
            sendNotification({
              title: "AeroTask",
              body: isBreak ? "Break complete." : "Focus complete.",
            });
          }
        });
      } catch (err) {
        setError(String(err));
      }
    })();

    return () => {
      if (unlistenTick) void unlistenTick();
      if (unlistenFinish) void unlistenFinish();
    };
  }, [isBreak]);

  const completedByDay = useMemo(() => {
    const map = new Map<number, number>();
    for (const task of tasks) {
      if (task.completed === 1) {
        const dayKey = startOfDay(task.timestamp);
        map.set(dayKey, (map.get(dayKey) ?? 0) + 1);
      }
    }
    return map;
  }, [tasks]);

  const heatmapMonths = useMemo(() => {
    const now = new Date();
    return Array.from({ length: HEATMAP_MONTHS }, (_, idx) => {
      const d = new Date(now.getFullYear(), now.getMonth() - (HEATMAP_MONTHS - idx - 1), 1);
      return { key: monthKey(d), label: monthLabel(d), grid: buildMonthGrid(d, completedByDay) };
    });
  }, [completedByDay]);

  async function onAddTask() {
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      await createTask(title);
      setNewTitle("");
      await refreshTasks();
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onToggle(task: Task) {
    if (busy) return;
    setBusy(true);
    try {
      await toggleTask(task.id, task.completed !== 1);
      await refreshTasks();
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: number) {
    if (busy) return;
    setBusy(true);
    try {
      await deleteTask(id);
      await refreshTasks();
      setError("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function savePomodoroSettings() {
    try {
      await invoke("pomodoro_set_settings", {
        focusMinutes: Number(focusMinutes),
        breakMinutes: Number(breakMinutes),
      });
      setError("");
      setShowSettings(false);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <div className="h-full w-full bg-transparent p-3 text-zinc-100">
      <div className="mx-auto flex h-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/50 shadow-2xl backdrop-blur-xl">
        <div className="flex h-10 items-center border-b border-white/10 bg-black/40 px-3" data-tauri-drag-region>
          <span className="text-xs font-medium uppercase tracking-[0.16em] text-zinc-400">AeroTask</span>
          <button
            className="ml-auto rounded p-1 text-zinc-400 transition-colors duration-150 hover:bg-zinc-800 hover:text-zinc-100"
            onClick={() => invoke("hide_main_window")}
            type="button"
            aria-label="hide"
          >
            <X size={15} />
          </button>
        </div>

        <header className="m-3 rounded-xl border border-white/10 bg-black/40 p-4">
          <div className="flex items-start">
            <div>
              <p className="text-xs uppercase tracking-widest text-zinc-400">{isBreak ? "Break" : "Focus"}</p>
              <div className="text-[42px] font-semibold leading-none tabular-nums">{formatTime(remainingMs)}</div>
            </div>
            <button
              className="ml-auto rounded p-1 text-zinc-400 transition-colors duration-150 hover:bg-zinc-800 hover:text-zinc-100"
              type="button"
              onClick={() => setShowSettings((prev) => !prev)}
              aria-label="pomodoro settings"
            >
              <Settings size={16} />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm transition-all duration-150 hover:-translate-y-[1px] hover:bg-zinc-800"
              onClick={async () => {
                try {
                  await invoke(isRunning ? "pomodoro_pause" : "pomodoro_start");
                  setError("");
                } catch (err) {
                  setError(String(err));
                }
              }}
              type="button"
            >
              {isRunning ? <Pause size={15} /> : <Play size={15} />}
              {isRunning ? "Pause" : "Start"}
            </button>
            <button
              className="inline-flex items-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm transition-all duration-150 hover:-translate-y-[1px] hover:bg-zinc-800"
              onClick={async () => {
                try {
                  await invoke("pomodoro_reset");
                  setError("");
                } catch (err) {
                  setError(String(err));
                }
              }}
              type="button"
            >
              <RotateCcw size={15} />
              Reset
            </button>
            <span className="ml-auto self-center text-xs text-zinc-400">{isRunning ? "Running" : "Idle"}</span>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              className={`rounded-md border px-2 py-1 text-xs transition-all duration-150 ${!isBreak ? "border-emerald-600 bg-emerald-900/40" : "border-zinc-700 bg-zinc-900 hover:bg-zinc-800"}`}
              type="button"
              onClick={() => invoke("pomodoro_set_mode", { isBreak: false })}
            >
              Focus
            </button>
            <button
              className={`rounded-md border px-2 py-1 text-xs transition-all duration-150 ${isBreak ? "border-emerald-600 bg-emerald-900/40" : "border-zinc-700 bg-zinc-900 hover:bg-zinc-800"}`}
              type="button"
              onClick={() => invoke("pomodoro_set_mode", { isBreak: true })}
            >
              Break
            </button>
          </div>
          {showSettings ? (
            <div className="mt-3 rounded-lg border border-white/10 bg-zinc-950/70 p-3 transition-all duration-200">
              <p className="mb-2 text-xs uppercase tracking-widest text-zinc-400">Timer Settings</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="text-xs text-zinc-400">
                  Focus (min)
                  <input
                    className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                    type="number"
                    min={1}
                    max={180}
                    value={focusMinutes}
                    onChange={(e) => setFocusMinutes(Number(e.target.value))}
                  />
                </label>
                <label className="text-xs text-zinc-400">
                  Break (min)
                  <input
                    className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
                    type="number"
                    min={1}
                    max={60}
                    value={breakMinutes}
                    onChange={(e) => setBreakMinutes(Number(e.target.value))}
                  />
                </label>
              </div>
              <button
                className="mt-3 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1 text-xs transition-colors duration-150 hover:bg-zinc-800"
                type="button"
                onClick={() => void savePomodoroSettings()}
              >
                Save Settings
              </button>
            </div>
          ) : null}
          {error ? <p className="mt-3 rounded border border-red-800/60 bg-red-950/50 px-2 py-1 text-xs text-red-300">{error}</p> : null}
        </header>

        <section className="mx-3 mb-3 flex min-h-0 flex-1 flex-col rounded-xl border border-white/10 bg-black/40 p-3">
          <p className="mb-2 text-xs uppercase tracking-widest text-zinc-400">Tasks</p>
          <div className="mb-3 flex gap-2">
            <input
              className="w-full rounded-md border border-zinc-700 bg-zinc-900/90 px-3 py-2 text-sm outline-none ring-0 placeholder:text-zinc-500"
              placeholder="Add a task..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void onAddTask();
              }}
            />
            <button
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm transition-all duration-150 hover:-translate-y-[1px] hover:bg-zinc-800"
              type="button"
              onClick={() => void onAddTask()}
            >
              Add
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {tasks.map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/80 px-2 py-2 transition-colors duration-150 hover:bg-zinc-900/80"
              >
                <button
                  type="button"
                  className="rounded p-1 text-emerald-400 transition-colors duration-150 hover:bg-zinc-800"
                  onClick={() => void onToggle(task)}
                  aria-label="toggle task"
                >
                  {task.completed ? <Check size={16} /> : <Square size={16} />}
                </button>
                <span className={`flex-1 text-sm ${task.completed ? "text-zinc-500 line-through" : "text-zinc-200"}`}>{task.title}</span>
                <button
                  type="button"
                  className="rounded p-1 text-zinc-400 transition-colors duration-150 hover:bg-zinc-800 hover:text-red-400"
                  onClick={() => void onDelete(task.id)}
                  aria-label="delete task"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            {tasks.length === 0 ? <p className="text-sm text-zinc-500">No tasks yet.</p> : null}
          </div>
        </section>

        <footer className="mx-3 mb-3 rounded-xl border border-white/10 bg-black/40 p-3">
          <div className="mb-2 flex items-center">
            <p className="text-xs uppercase tracking-widest text-zinc-400">Activity Heatmap</p>
            <span className="ml-auto text-[10px] text-zinc-500">Scroll horizontally</span>
          </div>
          <div
            className="flex gap-3 overflow-x-auto overflow-y-hidden pb-1 [scrollbar-width:thin]"
            ref={setHeatmapScrollEl}
            onWheel={(e) => {
              if (!heatmapScrollEl) return;
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) heatmapScrollEl.scrollLeft += e.deltaY;
            }}
          >
            <div className="grid grid-rows-7 gap-1 text-[10px] text-zinc-500">
              {WEEKDAY_LABELS.map((d) => (
                <div key={d} className="h-3 leading-3">
                  {d}
                </div>
              ))}
            </div>
            {heatmapMonths.map((month) => (
              <div key={month.key} className="flex min-w-max flex-col gap-1 pr-1">
                <p className="text-[10px] text-zinc-400">{month.label}</p>
                <div className="flex gap-1">
                  {month.grid.map((week, weekIdx) => (
                    <div key={`${month.key}-${weekIdx}`} className="grid grid-rows-7 gap-1">
                      {week.map((cell) => (
                        <div
                          key={cell.ts}
                          className={`h-3 w-3 rounded-[2px] transition-colors duration-200 ${cell.inMonth ? heatIntensity(cell.count) : "bg-zinc-900/30"}`}
                          title={`${new Date(cell.ts).toLocaleDateString()}: ${cell.count} completed`}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
}

export default App;
