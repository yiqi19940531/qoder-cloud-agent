import test from "node:test";
import assert from "node:assert/strict";
import { buildTrace } from "../src/lib/trace";
import type { QoderEvent } from "../src/lib/types";

test("Qoder 公开事件能关联工具调用、批准与返回，并隐藏敏感值", () => {
  const events: QoderEvent[] = [
    { id: "evt-message", type: "agent.message", processed_at: "2026-10-10T01:00:00Z", content: [{ type: "text", text: "先查询商品" }] },
    { id: "evt-tool", type: "agent.mcp_tool_use", processed_at: "2026-10-10T01:00:01Z", mcp_server_name: "apify", name: "mcp__apify__call-actor", evaluated_permission: "ask", input: { actor: "zen-studio/jd-com-search-scraper", maxItems: 20, token: "should-not-appear" } },
    { id: "evt-allow", type: "user.tool_confirmation", processed_at: "2026-10-10T01:00:02Z", tool_use_id: "evt-tool", result: "allow" },
    { id: "evt-result", type: "agent.mcp_tool_result", processed_at: "2026-10-10T01:00:04Z", mcp_tool_use_id: "evt-tool", is_error: false, content: [{ type: "text", text: '{"runId":"run-1","authorization":"Bearer hidden-token"}' }] },
    { id: "evt-question", type: "agent.custom_tool_use", processed_at: "2026-10-10T01:00:05Z", name: "ask_user", input: { question: "哪个平台？" } },
    { id: "evt-answer", type: "user.custom_tool_result", processed_at: "2026-10-10T01:00:07Z", custom_tool_use_id: "evt-question", content: [{ type: "text", text: "京东" }] },
    { id: "evt-thinking", type: "agent.thinking", processed_at: "2026-10-10T01:00:08Z" },
    { id: "evt-read", type: "agent.tool_use", processed_at: "2026-10-10T01:00:09Z", name: "Read", input: { file_path: "/tmp/output.txt" } },
    { id: "evt-read-result", type: "agent.tool_result", processed_at: "2026-10-10T01:00:10Z", tool_use_id: "evt-read", content: [{ type: "text", text: "读取成功" }] },
  ];
  const trace = buildTrace(events);
  const mcp = trace.steps.find((step) => step.id === "evt-tool");
  const question = trace.steps.find((step) => step.id === "evt-question");
  assert.equal(trace.counts.toolCalls, 3);
  assert.equal(trace.counts.completedTools, 3);
  assert.equal(mcp?.toolName, "call-actor");
  assert.equal(mcp?.approval, "allow");
  assert.equal(mcp?.durationMs, 3_000);
  assert.equal(mcp?.status, "success");
  assert.equal(mcp?.input?.text.includes("should-not-appear"), false);
  assert.equal(mcp?.output?.text.includes("hidden-token"), false);
  assert.equal(question?.output?.text, "京东");
  assert.equal(trace.steps.find((step) => step.id === "evt-read")?.provider, "Qoder 内置工具");
  assert.equal(trace.steps.find((step) => step.id === "evt-thinking")?.kind, "thinking");
});
