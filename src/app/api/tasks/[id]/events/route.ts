import { NextRequest } from "next/server";
import { getEventsAfter, taskRow } from "@/lib/db";
import { ensureWorker } from "@/lib/worker";
import { localRequestError } from "@/lib/http";

export const runtime = "nodejs";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const { id } = await context.params;
  if (!taskRow(id)) return new Response("Not found", { status: 404 });
  ensureWorker(id);
  let cursor = Number(request.headers.get("last-event-id") || request.nextUrl.searchParams.get("after") || "0");
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      try {
        while (!request.signal.aborted && Date.now() - started < 55_000) {
          const events = getEventsAfter(id, cursor);
          for (const event of events) {
            controller.enqueue(encoder.encode(`id: ${event.id}\nevent: update\ndata: ${JSON.stringify({ type: event.type, summary: event.summary })}\n\n`));
            cursor = event.id;
          }
          if (!events.length) controller.enqueue(encoder.encode(": keepalive\n\n"));
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch { /* The browser may disconnect while a chunk is in flight. */ }
      finally { try { controller.close(); } catch { /* already closed */ } }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
