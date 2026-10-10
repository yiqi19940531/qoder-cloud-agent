import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addMessage, getTaskView, patchTask, taskRow } from "@/lib/db";
import { sendMessage } from "@/lib/qoder";
import { ensureWorker } from "@/lib/worker";
import { errorResponse, localRequestError } from "@/lib/http";

export const runtime = "nodejs";
const schema = z.object({ message: z.string().trim().min(1).max(8000) });
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "请输入追问内容。" }, { status: 400 });
  const row = taskRow(id);
  if (!row) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  if (row.status !== "completed" && row.status !== "failed") return NextResponse.json({ error: "当前任务尚未结束；请等待或回答待处理问题。" }, { status: 409 });
  if (!row.qoder_session_id) return NextResponse.json({ error: "该任务没有 Qoder 会话。" }, { status: 409 });
  try {
    await sendMessage(row.qoder_session_id as string, parsed.data.message);
    addMessage(id, "user", parsed.data.message);
    patchTask(id, { status: "running", phase: "正在分析追问", error: null });
    ensureWorker(id);
    return NextResponse.json({ task: getTaskView(id) });
  } catch (error) { return errorResponse(error, 502); }
}
