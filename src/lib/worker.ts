import { randomUUID } from "node:crypto";
import { ACTORS, JD_FALLBACK_ACTOR } from "./actors";
import { addEvent, addMessage, db, getProducts, patchTask, recordAgentQuestion, taskRow } from "./db";
import { getSession, listEvents, sendToolConfirmation, sendToolResult, streamEvents } from "./qoder";
import type { QoderEvent } from "./types";
import { redactSecrets } from "./secrets";
import { publishRemoteResults, reservePaidMcpCall } from "./remote-mcp";

const workers = new Map<string, Promise<void>>();

function textContent(event: QoderEvent) {
  return (event.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join("\n").trim();
}

function markLocal(taskId: string, type: string, summary: string) {
  addEvent(taskId, `local_${randomUUID()}`, type, summary);
}

async function sendToolResultOnce(sessionId: string, toolUseId: string, result: unknown, isError = false) {
  try {
    await sendToolResult(sessionId, toolUseId, result, isError);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/Qoder (404|409)/.test(message)) throw error;
    const later = await listEvents(sessionId, toolUseId);
    if (!later.some((event) => event.type === "user.custom_tool_result" && event.custom_tool_use_id === toolUseId)) throw error;
  }
}

async function sendToolConfirmationOnce(sessionId: string, toolUseId: string, allow: boolean, reason?: string) {
  try {
    await sendToolConfirmation(sessionId, toolUseId, allow, reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/Qoder (404|409)/.test(message)) throw error;
    const later = await listEvents(sessionId, toolUseId);
    if (!later.some((event) => event.type === "user.tool_confirmation" && event.tool_use_id === toolUseId)) throw error;
  }
}

async function handleCustomTool(taskId: string, sessionId: string, event: QoderEvent) {
  const name = event.name || "";
  if (name === "ask_user") {
    const question = typeof event.input?.question === "string" ? event.input.question.trim() : "请补充完成任务所需的信息。";
    recordAgentQuestion(taskId, event.id, question);
    return;
  }
  if (name === "list_actors") {
    const registry = [...Object.entries(ACTORS).map(([platform, actor]) => {
      const verification = db.prepare("SELECT status,result_count,checked_at FROM actor_verifications WHERE platform=? AND actor_id=?")
        .get(platform, actor.id) as Record<string, unknown> | undefined;
      return { platform, actorId: actor.id, description: actor.description, inputExample: actor.input, rankingBasis: actor.rankingBasis, verification: verification || "candidate" };
    }), (() => {
      const verification = db.prepare("SELECT status,result_count,checked_at FROM actor_verifications WHERE platform='jd' AND actor_id=?")
        .get(JD_FALLBACK_ACTOR) as Record<string, unknown> | undefined;
      return { platform: "jd", actorId: JD_FALLBACK_ACTOR, description: "京东备用 Actor；无逐条评论，实测 20 行但仅 18 件去重商品。", inputExample: { keywords: ["洗发水"], maxItems: 26, includeDetails: true }, rankingBasis: "关键词搜索结果位置，不是真实销量排名", verification: verification || "candidate" };
    })()];
    await sendToolResultOnce(sessionId, event.id, registry);
    return;
  }
  if (name === "load_saved_data") {
    const products = getProducts(taskId);
    await sendToolResultOnce(sessionId, event.id, { count: products.length, products: products.map((product) => ({ ...product, reviewSamples: product.reviewSamples.slice(0, 3) })) });
    return;
  }
  if (name === "publish_results") {
    patchTask(taskId, { status: "running", phase: "正在保存远端 Agent 的商品结果" });
    try {
      const result = publishRemoteResults(taskId, event.input || {});
      if (taskRow(taskId)?.status !== "cancelled") await sendToolResultOnce(sessionId, event.id, result);
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : "结果保存失败");
      markLocal(taskId, "tool_error", message);
      if (taskRow(taskId)?.status !== "cancelled") await sendToolResultOnce(sessionId, event.id, { error: message, partialProducts: getProducts(taskId).length }, true);
    }
    return;
  }
  await sendToolResult(sessionId, event.id, { error: `未知工具：${name}` }, true);
}

async function handleToolApproval(taskId: string, sessionId: string, event: QoderEvent) {
  const decision = reservePaidMcpCall(taskId, event);
  if (decision.allow) {
    patchTask(taskId, { status: "running", phase: `远端 Agent 准备通过 Apify MCP 运行 ${decision.actorId}` });
    markLocal(taskId, "mcp_approved", `已批准一次远端 Apify MCP 调用；单次费用上限 $${(decision.capMicros / 1_000_000).toFixed(2)}`);
  } else {
    markLocal(taskId, "mcp_denied", decision.reason);
  }
  await sendToolConfirmationOnce(sessionId, event.id, decision.allow, decision.allow ? undefined : decision.reason);
}

async function handleEvent(taskId: string, sessionId: string, event: QoderEvent) {
  const summary = event.type === "agent.message" ? textContent(event).slice(0, 4000) : event.type;
  const inserted = addEvent(taskId, event.id, event.type, summary);
  if (event.type === "agent.custom_tool_use") {
    // Keep the Qoder cursor behind a pending custom tool until its result is sent.
    await handleCustomTool(taskId, sessionId, event);
  } else if (event.type === "agent.tool_use") {
    await handleToolApproval(taskId, sessionId, event);
  } else if (event.type === "agent.message" && inserted) {
    const text = textContent(event);
    if (text) addMessage(taskId, "agent", text);
  } else if (event.type === "session.status_running") {
    patchTask(taskId, { status: "running", phase: "Agent 正在分析任务", error: null });
  } else if (event.type === "agent.mcp_tool_use") {
    if (event.evaluated_permission === "ask") await handleToolApproval(taskId, sessionId, event);
    else patchTask(taskId, { phase: event.name?.endsWith("call-actor") ? "远端 Agent 正在运行 Apify Actor" : "远端 Agent 正在调用 Apify MCP" });
  } else if (event.type === "agent.mcp_tool_result") {
    patchTask(taskId, { phase: "远端 Agent 正在处理 Apify 返回的数据" });
  } else if (event.type === "session.usage" && typeof event.total_credits === "number") {
    patchTask(taskId, { qoder_credits: event.total_credits });
  } else if (event.type === "session.status_idle") {
    if (event.stop_reason?.type === "requires_action") {
      const row = taskRow(taskId);
      if (row?.pending_question) patchTask(taskId, { status: "waiting", phase: "等待用户补充信息" });
    } else {
      const row = taskRow(taskId);
      if (row?.status !== "cancelled" && (row?.status !== "failed" || row.phase === "事件连接中断")) {
        patchTask(taskId, { status: "completed", phase: "任务已完成", pending_tool_id: null, pending_question: null, error: null });
      }
    }
  } else if (event.type === "session.error") {
    patchTask(taskId, { status: "failed", phase: "Qoder 执行失败", error: "Qoder Session 返回错误，请检查事件记录或重试。" });
  }
  patchTask(taskId, { event_cursor: event.id });
}

async function runWorker(taskId: string) {
  let failures = 0;
  while (true) {
    const row = taskRow(taskId);
    if (!row?.qoder_session_id || ["cancelled", "completed", "waiting"].includes(row.status as string)) return;
    const sessionId = row.qoder_session_id as string;
    try {
      const history = await listEvents(sessionId, row.event_cursor as string | undefined);
      for (const event of history) await handleEvent(taskId, sessionId, event);
      const afterHistory = taskRow(taskId);
      if (afterHistory?.status === "failed" && afterHistory.phase === "事件连接中断") {
        if (afterHistory.pending_question) {
          patchTask(taskId, { status: "waiting", phase: "等待用户补充信息", error: null });
        } else if ((await getSession(sessionId)).status === "idle") {
          patchTask(taskId, { status: "completed", phase: "任务已完成", error: null });
        }
      }
      if (["cancelled", "completed", "waiting"].includes(taskRow(taskId)?.status as string)) return;
      const cursor = afterHistory?.event_cursor as string | undefined;
      // An absent cursor starts at the tail. The history query above normally provides one.
      for await (const event of streamEvents(sessionId, cursor)) {
        await handleEvent(taskId, sessionId, event);
        const status = taskRow(taskId)?.status;
        if (status === "cancelled" || status === "completed") return;
        // Collect usage and the requires_action idle event before parking a
        // question; the answer route will start the worker again.
        if (status === "waiting" && event.type === "session.status_idle") return;
      }
      failures = 0;
    } catch (error) {
      if (["cancelled", "completed", "waiting"].includes(taskRow(taskId)?.status as string)) return;
      failures++;
      const message = redactSecrets(error instanceof Error ? error.message : "事件连接失败");
      markLocal(taskId, "connection_error", message);
      if (failures >= 5) {
        patchTask(taskId, { status: "failed", phase: "事件连接中断", error: message });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** failures, 15_000)));
    }
  }
}

export function ensureWorker(taskId: string) {
  if (workers.has(taskId)) return;
  const row = taskRow(taskId);
  if (!row?.qoder_session_id || ["cancelled", "completed", "waiting"].includes(row.status as string)) return;
  if (row.status === "failed" && row.phase !== "事件连接中断") return;
  const promise = runWorker(taskId).finally(() => workers.delete(taskId));
  workers.set(taskId, promise);
}

export function recoverWorkers() {
  const rows = db.prepare("SELECT id FROM tasks WHERE status IN ('starting','running','waiting','failed') AND qoder_session_id IS NOT NULL")
    .all() as Array<{ id: string }>;
  for (const row of rows) ensureWorker(row.id);
}

export async function reconcileTask(taskId: string) {
  const row = taskRow(taskId);
  if (!row?.qoder_session_id) return;
  const session = await getSession(row.qoder_session_id as string);
  if (typeof session.usage?.total_credits === "number") patchTask(taskId, { qoder_credits: session.usage.total_credits });
  ensureWorker(taskId);
}
