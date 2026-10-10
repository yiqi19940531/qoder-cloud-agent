import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addMessage, getTaskView, patchTask, taskRow } from "@/lib/db";
import { listEvents, sendToolResult } from "@/lib/qoder";
import { ensureWorker } from "@/lib/worker";
import { errorResponse, localRequestError } from "@/lib/http";

export const runtime = "nodejs";
const schema = z.object({ answer: z.string().trim().min(1).max(4000) });
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const { id } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "请输入回答。" }, { status: 400 });
  const row = taskRow(id);
  if (!row) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  if (!row.pending_tool_id || !row.qoder_session_id) return NextResponse.json({ error: "当前没有待回答的问题。" }, { status: 409 });
  try {
    try {
      await sendToolResult(row.qoder_session_id as string, row.pending_tool_id as string, parsed.data.answer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/Qoder (404|409)/.test(message)) throw error;
      const events = await listEvents(row.qoder_session_id as string, row.pending_tool_id as string);
      if (!events.some((event) => event.type === "user.custom_tool_result" && event.custom_tool_use_id === row.pending_tool_id)) throw error;
    }
    addMessage(id, "user", parsed.data.answer);
    patchTask(id, { status: "running", phase: "Agent 已收到回答，继续执行", pending_tool_id: null, pending_question: null });
    ensureWorker(id);
    return NextResponse.json({ task: getTaskView(id) });
  } catch (error) { return errorResponse(error, 502); }
}
