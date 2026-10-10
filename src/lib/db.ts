import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Product, TaskStatus, TaskView } from "./types";

// The database path is a runtime value; it must never be bundled into a client or traced into deployment assets.
const dbPath = path.resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH || "./data/research.db");
fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
const database = new DatabaseSync(dbPath);
// Next.js evaluates route modules in parallel during builds. Install the busy
// timeout before each worker asks SQLite to enable WAL or create tables.
database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
database.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  qoder_session_id TEXT UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  pending_tool_id TEXT,
  pending_question TEXT,
  error TEXT,
  qoder_credits REAL,
  apify_budget_micros INTEGER NOT NULL DEFAULT 2000000,
  apify_spent_micros INTEGER NOT NULL DEFAULT 0,
  event_cursor TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  qoder_event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, qoder_event_id)
);
CREATE TABLE IF NOT EXISTS products (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  product_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY(task_id, platform, product_id)
);
CREATE TABLE IF NOT EXISTS actor_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tool_event_id TEXT NOT NULL,
  apify_run_id TEXT UNIQUE,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  cap_micros INTEGER NOT NULL,
  cost_micros INTEGER,
  dataset_id TEXT,
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, tool_event_id)
);
CREATE TABLE IF NOT EXISTS actor_verifications (
  platform TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(platform, actor_id)
);
CREATE TABLE IF NOT EXISTS collections (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  keyword TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, platform, keyword, actor_id)
);
CREATE TABLE IF NOT EXISTS mcp_calls (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  tool_event_id TEXT NOT NULL UNIQUE,
  actor_id TEXT NOT NULL,
  max_charge_micros INTEGER NOT NULL,
  run_id TEXT,
  dataset_id TEXT,
  actual_cost_micros INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

export const db = database;
export const now = () => new Date().toISOString();

export function createTask(id: string, title: string) {
  const stamp = now();
  db.prepare(`INSERT INTO tasks (id,title,status,phase,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, title, "starting", "正在创建 Qoder 会话", stamp, stamp);
}

export function patchTask(id: string, fields: Record<string, string | number | null>) {
  const entries = Object.entries(fields);
  if (!entries.length) return;
  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, value]) => value), now(), id);
}

export function taskRow(id: string) {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

export function listTaskRows() {
  return db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100").all() as Record<string, unknown>[];
}

export function addMessage(taskId: string, role: "user" | "agent" | "system" | "question", text: string) {
  db.prepare("INSERT INTO messages (task_id,role,text,created_at) VALUES (?,?,?,?)")
    .run(taskId, role, text, now());
}

export function addEvent(taskId: string, qoderEventId: string, type: string, summary: string) {
  const result = db.prepare("INSERT OR IGNORE INTO events (task_id,qoder_event_id,type,summary,created_at) VALUES (?,?,?,?,?)")
    .run(taskId, qoderEventId, type, summary, now());
  return result.changes > 0;
}

export function recordAgentQuestion(taskId: string, toolEventId: string, question: string) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (addEvent(taskId, `local_question_${toolEventId}`, "question", question)) {
      addMessage(taskId, "question", question);
    }
    patchTask(taskId, {
      status: "waiting",
      phase: "等待用户补充信息",
      pending_tool_id: toolEventId,
      pending_question: question,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getEventsAfter(taskId: string, id = 0) {
  return db.prepare("SELECT id,type,summary,created_at FROM events WHERE task_id = ? AND id > ? ORDER BY id LIMIT 200")
    .all(taskId, id) as Array<{ id: number; type: string; summary: string; created_at: string }>;
}

export function upsertProduct(taskId: string, product: Product) {
  const previous = db.prepare("SELECT data_json FROM products WHERE task_id=? AND platform=? AND product_id=?")
    .get(taskId, product.platform, product.productId) as { data_json: string } | undefined;
  const merged: Product = previous ? (() => {
    const old = JSON.parse(previous.data_json) as Product;
    const supplied = Object.fromEntries(Object.entries(product).filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0)));
    return { ...old, ...supplied, status: old.status === "complete" ? "complete" : product.status } as Product;
  })() : product;
  db.prepare("INSERT INTO products (task_id,platform,product_id,data_json) VALUES (?,?,?,?) ON CONFLICT(task_id,platform,product_id) DO UPDATE SET data_json=excluded.data_json")
    .run(taskId, product.platform, product.productId, JSON.stringify(merged));
}

export function getProducts(taskId: string): Product[] {
  const rows = db.prepare("SELECT data_json FROM products WHERE task_id = ? ORDER BY json_extract(data_json, '$.rank') ASC, product_id ASC")
    .all(taskId) as Array<{ data_json: string }>;
  return rows.map((row) => JSON.parse(row.data_json) as Product);
}

export function getTaskView(id: string): TaskView | null {
  const row = taskRow(id);
  if (!row) return null;
  const messages = db.prepare("SELECT id,role,text,created_at FROM messages WHERE task_id=? ORDER BY id")
    .all(id) as Array<{ id: number; role: "user" | "agent" | "system" | "question"; text: string; created_at: string }>;
  // Older sessions stored questions only in events. New questions are written to
  // messages atomically, so the transcript keeps their exact order with answers.
  const questions = db.prepare("SELECT id,summary,created_at FROM events WHERE task_id=? AND type='question' AND qoder_event_id NOT LIKE 'local_question_%' ORDER BY id")
    .all(id) as Array<{ id: number; summary: string; created_at: string }>;
  const currentMessages = messages.map((message) => ({ id: message.id, role: message.role, text: message.text, createdAt: message.created_at, kind: message.role === "question" ? "question" as const : "message" as const }));
  const conversation = questions.length === 0 ? currentMessages : [
    ...currentMessages,
    ...questions.map((question) => ({ id: -question.id, role: "question" as const, text: question.summary, createdAt: question.created_at, kind: "question" as const })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id - right.id);
  const mcpCall = db.prepare("SELECT actual_cost_micros FROM mcp_calls WHERE task_id=?").get(id) as { actual_cost_micros: number | null } | undefined;
  return {
    id,
    qoderSessionId: row.qoder_session_id as string | null,
    title: row.title as string,
    status: row.status as TaskStatus,
    phase: row.phase as string,
    pendingQuestion: row.pending_question as string | null,
    error: row.error as string | null,
    qoderCredits: row.qoder_credits as number | null,
    apifyBudgetUsd: Number(row.apify_budget_micros) / 1_000_000,
    apifySpentUsd: mcpCall && mcpCall.actual_cost_micros === null ? null : Number(row.apify_spent_micros) / 1_000_000,
    products: getProducts(id),
    messages: conversation,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
