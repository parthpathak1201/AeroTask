import Database from "@tauri-apps/plugin-sql";

export type Task = {
  id: number;
  title: string;
  completed: number;
  timestamp: number;
};

let dbPromise: Promise<Database> | null = null;

async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:aerotask.db");
  }
  return dbPromise;
}

export async function initSchema(): Promise<void> {
  const db = await getDb();
  await db.execute(
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    )`,
  );
}

export async function getTasks(): Promise<Task[]> {
  const db = await getDb();
  const rows = await db.select<Task[]>(
    "SELECT id, title, completed, timestamp FROM tasks ORDER BY timestamp DESC",
  );
  return rows;
}

export async function createTask(title: string): Promise<void> {
  const db = await getDb();
  await db.execute("INSERT INTO tasks (title, completed, timestamp) VALUES (?, 0, ?)", [
    title.trim(),
    Date.now(),
  ]);
}

export async function toggleTask(id: number, completed: boolean): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE tasks SET completed = ?, timestamp = ? WHERE id = ?", [
    completed ? 1 : 0,
    Date.now(),
    id,
  ]);
}

export async function deleteTask(id: number): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM tasks WHERE id = ?", [id]);
}
