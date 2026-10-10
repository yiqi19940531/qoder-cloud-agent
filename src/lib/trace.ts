import { redactSecrets } from "./secrets";
import type { QoderEvent } from "./types";

export interface TracePayload {
  text: string;
  totalChars: number;
  truncated: boolean;
}

export interface TraceStep {
  id: string;
  eventType: string;
  kind: "tool" | "agent" | "user" | "thinking" | "session" | "usage" | "error";
  at: string | null;
  title: string;
  detail?: TracePayload;
  provider?: string;
  toolName?: string;
  input?: TracePayload;
  output?: TracePayload;
  status?: "running" | "success" | "error" | "denied" | "waiting";
  approval?: "allow" | "deny";
  durationMs?: number;
  resultEventId?: string;
}

const SENSITIVE_KEY = /(?:^|[_-])(token|secret|password|credential|cookie|authorization|api[_-]?key)(?:$|[_-])/i;

function scrubText(value: string) {
  return redactSecrets(value)
    .replace(/apify_api_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:token|secret|password|credential|cookie|authorization|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]");
}

function clean(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[深层数据已省略]";
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : clean(item, depth + 1)]));
  }
  return value;
}

function payload(value: unknown, maxChars = 12_000): TracePayload {
  let rendered: string;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      rendered = JSON.stringify(clean(parsed), null, 2);
    } catch {
      rendered = scrubText(value);
    }
  } else {
    rendered = JSON.stringify(clean(value), null, 2) ?? "";
  }
  return { text: rendered.slice(0, maxChars), totalChars: rendered.length, truncated: rendered.length > maxChars };
}

function content(event: QoderEvent) {
  const blocks = Array.isArray(event.content) ? event.content : [];
  return blocks.map((block) => block.type === "text" && typeof block.text === "string"
    ? block.text : `[${block.type || "未知"} 内容]`).join("\n");
}

function field(event: QoderEvent, key: string): string | null {
  const value = event[key];
  return typeof value === "string" ? value : null;
}

function duration(start: string | null, end: string | null) {
  if (!start || !end) return undefined;
  const elapsed = Date.parse(end) - Date.parse(start);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined;
}

function toolLabel(event: QoderEvent) {
  const name = event.name || "未命名工具";
  if (event.type === "agent.mcp_tool_use") {
    return { provider: `${field(event, "mcp_server_name") || "MCP"} MCP`, name: name.replace(/^mcp__[^_]+__/, "") };
  }
  return { provider: event.type === "agent.custom_tool_use" ? "应用自定义工具" : "Qoder 内置工具", name };
}

export function buildTrace(events: QoderEvent[]) {
  const steps: TraceStep[] = [];
  const tools = new Map<string, TraceStep>();

  for (const event of events) {
    const at = event.processed_at || null;
    if (["agent.mcp_tool_use", "agent.custom_tool_use", "agent.tool_use"].includes(event.type)) {
      const label = toolLabel(event);
      const step: TraceStep = {
        id: event.id, eventType: event.type, kind: "tool", at,
        title: label.name, toolName: label.name, provider: label.provider,
        input: payload(event.input || {}),
        status: event.evaluated_permission === "ask" ? "waiting" : "running",
      };
      steps.push(step);
      tools.set(event.id, step);
      continue;
    }
    if (["agent.mcp_tool_result", "agent.tool_result", "user.custom_tool_result", "user.tool_result"].includes(event.type)) {
      const useId = field(event, "mcp_tool_use_id") || field(event, "custom_tool_use_id") || field(event, "tool_use_id");
      const step = useId ? tools.get(useId) : undefined;
      if (step) {
        step.output = payload(content(event));
        step.status = event.is_error === true ? "error" : step.status === "denied" ? "denied" : "success";
        step.durationMs = duration(step.at, at);
        step.resultEventId = event.id;
      } else {
        steps.push({ id: event.id, eventType: event.type, kind: "tool", at,
          title: "未匹配的工具结果", output: payload(content(event)),
          status: event.is_error === true ? "error" : "success" });
      }
      continue;
    }
    if (event.type === "user.tool_confirmation") {
      const useId = field(event, "tool_use_id");
      const step = useId ? tools.get(useId) : undefined;
      const decision = event.result === "allow" ? "allow" : "deny";
      if (step) {
        step.approval = decision;
        step.status = decision === "deny" ? "denied" : "running";
      } else {
        steps.push({ id: event.id, eventType: event.type, kind: "session", at,
          title: decision === "allow" ? "工具调用获批" : "工具调用被拒绝" });
      }
      continue;
    }
    if (event.type === "agent.message" || event.type === "user.message") {
      steps.push({ id: event.id, eventType: event.type,
        kind: event.type === "agent.message" ? "agent" : "user", at,
        title: event.type === "agent.message" ? "Agent 说明" : "用户请求",
        detail: payload(content(event), 4_000) });
      continue;
    }
    if (event.type === "agent.thinking") {
      steps.push({ id: event.id, eventType: event.type, kind: "thinking", at,
        title: "Agent 推理中", detail: payload("Qoder 公开事件仅提供推理标记，不提供内部推理正文。") });
      continue;
    }
    if (event.type === "session.status_running" || event.type === "session.status_idle") {
      steps.push({ id: event.id, eventType: event.type, kind: "session", at,
        title: event.type === "session.status_running" ? "会话开始执行" : "本轮执行结束",
        detail: event.stop_reason?.type ? payload(`结束原因：${event.stop_reason.type}`) : undefined });
      continue;
    }
    if (event.type === "session.usage") {
      const credits = typeof event.total_credits === "number" ? event.total_credits : null;
      steps.push({ id: event.id, eventType: event.type, kind: "usage", at,
        title: credits === null ? "Qoder 用量更新" : `Qoder 累计 ${credits.toFixed(2)} Credits` });
      continue;
    }
    if (event.type === "session.error") {
      steps.push({ id: event.id, eventType: event.type, kind: "error", at,
        title: "Qoder 会话错误", detail: payload(event.error || "未知错误", 4_000) });
    }
  }

  const toolSteps = steps.filter((step) => step.kind === "tool");
  return {
    steps,
    counts: {
      totalEvents: events.length,
      toolCalls: toolSteps.filter((step) => step.toolName).length,
      completedTools: toolSteps.filter((step) => step.status === "success").length,
      failedTools: toolSteps.filter((step) => step.status === "error" || step.status === "denied").length,
    },
    lastEventId: events.at(-1)?.id || null,
  };
}
