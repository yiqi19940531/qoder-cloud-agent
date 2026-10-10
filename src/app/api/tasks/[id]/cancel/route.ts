import { NextRequest, NextResponse } from "next/server";
import { getTaskView, patchTask, taskRow } from "@/lib/db";
import { cancelSession } from "@/lib/qoder";
import { errorResponse, localRequestError } from "@/lib/http";

export const runtime = "nodejs";
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const { id } = await context.params;
  const row = taskRow(id);
  if (!row) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  try {
    if (row.qoder_session_id) await cancelSession(row.qoder_session_id as string);
    patchTask(id, { status: "cancelled", phase: "任务已取消", pending_tool_id: null, pending_question: null });
    return NextResponse.json({ task: getTaskView(id) });
  } catch (error) { return errorResponse(error, 502); }
}
