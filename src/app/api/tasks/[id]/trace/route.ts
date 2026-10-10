import { NextRequest, NextResponse } from "next/server";
import { taskRow } from "@/lib/db";
import { localRequestError, errorResponse } from "@/lib/http";
import { listEvents } from "@/lib/qoder";
import { buildTrace } from "@/lib/trace";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const { id } = await context.params;
  const task = taskRow(id);
  if (!task) return NextResponse.json({ error: "任务不存在。" }, { status: 404 });
  if (!task.qoder_session_id) return NextResponse.json({ error: "这份旧版验证记录没有 Qoder Cloud Session。" }, { status: 409 });
  try {
    const events = await listEvents(task.qoder_session_id as string);
    return NextResponse.json({
      task: {
        id, title: task.title, status: task.status, phase: task.phase,
        sessionId: task.qoder_session_id, credits: task.qoder_credits,
      },
      ...buildTrace(events),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, 502);
  }
}
