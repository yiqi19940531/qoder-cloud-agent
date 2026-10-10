import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createTask, addMessage, db, getTaskView, patchTask } from "@/lib/db";
import { createSession, sendMessage } from "@/lib/qoder";
import { ensureWorker, recoverWorkers } from "@/lib/worker";
import { errorResponse, localRequestError } from "@/lib/http";

export const runtime = "nodejs";
const inputSchema = z.object({ prompt: z.string().trim().min(3).max(8000) });

export function GET(request: NextRequest) {
  const denied = localRequestError(request);
  if (denied) return denied;
  recoverWorkers();
  const rows = db.prepare("SELECT id,title,status,phase,created_at,updated_at, (qoder_session_id IS NOT NULL) AS has_qoder_session FROM tasks ORDER BY created_at DESC LIMIT 100").all();
  return NextResponse.json({ tasks: rows });
}

export async function POST(request: NextRequest) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const parsed = inputSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "请输入 3–8000 字的研究需求。" }, { status: 400 });
  if (!process.env.QODER_ACCESS_TOKEN || !process.env.QODER_AGENT_ID || !process.env.QODER_ENVIRONMENT_ID || !process.env.QODER_APIFY_VAULT_ID || process.env.QODER_APIFY_MCP_READY !== "true") {
    return NextResponse.json({ error: "请先配置 Qoder Agent 与远端 Apify MCP Vault。" }, { status: 503 });
  }
  const id = randomUUID();
  createTask(id, parsed.data.prompt.slice(0, 55));
  addMessage(id, "user", parsed.data.prompt);
  try {
    const session = await createSession(parsed.data.prompt.slice(0, 55));
    patchTask(id, { qoder_session_id: session.id, status: "running", phase: "正在分析用户需求" });
    await sendMessage(session.id, parsed.data.prompt);
    ensureWorker(id);
    return NextResponse.json({ task: getTaskView(id) }, { status: 201 });
  } catch (error) {
    patchTask(id, { status: "failed", phase: "创建任务失败", error: error instanceof Error ? error.message : "创建失败" });
    return errorResponse(error, 502);
  }
}
