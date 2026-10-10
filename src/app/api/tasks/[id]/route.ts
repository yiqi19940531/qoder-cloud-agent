import { NextRequest, NextResponse } from "next/server";
import { getTaskView } from "@/lib/db";
import { ensureWorker } from "@/lib/worker";
import { localRequestError } from "@/lib/http";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const { id } = await context.params;
  ensureWorker(id);
  const task = getTaskView(id);
  return task ? NextResponse.json({ task }) : NextResponse.json({ error: "任务不存在" }, { status: 404 });
}
