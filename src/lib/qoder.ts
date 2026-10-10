import type { QoderEvent } from "./types";
import { redactSecrets } from "./secrets";

const BASE = "https://api.qoder.com/api/v1/cloud";

function token() {
  const value = process.env.QODER_ACCESS_TOKEN;
  if (!value) throw new Error("缺少 QODER_ACCESS_TOKEN，请先完成 Qoder 配置。");
  return value;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
    throw new Error(redactSecrets(`Qoder ${response.status}: ${message}`));
  }
  return body as T;
}

export function qoderRequest<T>(path: string, init: RequestInit = {}) {
  return request<T>(path, init);
}

export async function createSession(title: string) {
  const agentId = process.env.QODER_AGENT_ID;
  const environmentId = process.env.QODER_ENVIRONMENT_ID;
  const vaultId = process.env.QODER_APIFY_VAULT_ID;
  if (!agentId || !environmentId || !vaultId || process.env.QODER_APIFY_MCP_READY !== "true") throw new Error("缺少 Qoder Agent、Environment 或已认证的 Apify MCP Vault，请先运行 npm run setup:qoder。");
  return request<{ id: string; status: string }>("/sessions", {
    method: "POST",
    body: JSON.stringify({
      agent: { type: "agent", id: agentId },
      environment_id: environmentId,
      vault_ids: [vaultId],
      title,
      budget: { type: "limit", max_credit_cost: "200.00" },
    }),
  });
}

export async function sendToolConfirmation(sessionId: string, toolUseId: string, allow: boolean, reason?: string) {
  return request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    body: JSON.stringify({ events: [{
      type: "user.tool_confirmation",
      tool_use_id: toolUseId,
      result: allow ? "allow" : "deny",
      ...(!allow ? { deny_message: reason || "该工具调用不符合任务权限或费用限制。" } : {}),
    }] }),
  });
}

export async function sendMessage(sessionId: string, text: string) {
  return request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] }),
  });
}

export async function sendToolResult(sessionId: string, toolUseId: string, result: unknown, isError = false) {
  return request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
    method: "POST",
    body: JSON.stringify({
      events: [{
        type: "user.custom_tool_result",
        custom_tool_use_id: toolUseId,
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
        is_error: isError,
      }],
    }),
  });
}

export async function listEvents(sessionId: string, afterId?: string): Promise<QoderEvent[]> {
  const all: QoderEvent[] = [];
  let page: string | undefined;
  do {
    const params = new URLSearchParams({ limit: "100", order: "asc" });
    if (page) params.set("page", page);
    else if (afterId) params.set("after_id", afterId);
    const response = await request<{ data: QoderEvent[]; next_page: string | null }>(
      `/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`,
    );
    all.push(...response.data);
    page = response.next_page || undefined;
  } while (page);
  return all;
}

export async function getSession(sessionId: string) {
  return request<{ status: string; usage?: { total_credits?: number } }>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function cancelSession(sessionId: string) {
  return request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" });
}

export async function* streamEvents(sessionId: string, lastEventId?: string, signal?: AbortSignal): AsyncGenerator<QoderEvent> {
  const response = await fetch(`${BASE}/sessions/${encodeURIComponent(sessionId)}/events/stream`, {
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: "text/event-stream",
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
    },
    signal,
    cache: "no-store",
  });
  if (!response.ok || !response.body) throw new Error(`Qoder SSE 连接失败：HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: { id?: string; event?: string; data?: string } = {};
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (frame.data && frame.event !== "event_delta" && frame.event !== "event_start") {
            try {
              const event = JSON.parse(frame.data) as QoderEvent;
              if (event.id && event.type) yield event;
            } catch { /* Ignore malformed heartbeat or partial frames. */ }
          }
          frame = {};
        } else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:")) frame.data = `${frame.data || ""}${line.slice(5).trimStart()}`;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
