import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const folder = fs.mkdtempSync(path.join(os.tmpdir(), "commerce-mcp-test-"));
process.env.DATABASE_PATH = path.join(folder, "test.db");
process.env.QODER_ACCESS_TOKEN = "test-qoder-token";

after(async () => {
  const { db } = await import("../src/lib/db");
  db.close();
  fs.rmSync(folder, { recursive: true, force: true });
});

const callEvent = (id: string, cap = 2, actor = "zen-studio/jd-com-search-scraper") => ({
  id, type: "agent.tool_use", name: "mcp__apify__call-actor",
  input: { actor, input: { keyword: "洗发水", maxItems: 20, maxReviewsPerItem: 10 }, callOptions: { maxItems: 20, maxTotalChargeUsd: cap } },
});

test("远端 MCP 付费调用必须使用登记 Actor 和 $2 以内硬上限", async () => {
  const { inspectPaidMcpCall } = await import("../src/lib/remote-mcp");
  assert.equal(inspectPaidMcpCall(callEvent("evt-1")).allow, true);
  assert.equal(inspectPaidMcpCall({ ...callEvent("evt-mcp"), type: "agent.mcp_tool_use", mcp_server_name: "apify", evaluated_permission: "ask" }).allow, true);
  assert.equal(inspectPaidMcpCall(callEvent("evt-2", 3)).allow, false);
  assert.equal(inspectPaidMcpCall(callEvent("evt-3", 2, "unknown/actor")).allow, false);
  assert.equal(inspectPaidMcpCall({ ...callEvent("evt-4"), input: { actor: "zen-studio/jd-com-search-scraper", input: { maxItems: 20 }, callOptions: {} } }).allow, false);
});

test("每个 Qoder Session 最多批准一次 Apify MCP Actor 运行", async () => {
  const { createTask } = await import("../src/lib/db");
  const { reservePaidMcpCall } = await import("../src/lib/remote-mcp");
  createTask("task-mcp", "京东洗发水");
  assert.equal(reservePaidMcpCall("task-mcp", callEvent("evt-one")).allow, true);
  assert.equal(reservePaidMcpCall("task-mcp", callEvent("evt-one")).allow, true);
  assert.equal(reservePaidMcpCall("task-mcp", callEvent("evt-two")).allow, false);
});

test("Agent 追问在回答后仍按原顺序保留，重放事件不会重复", async () => {
  const { addMessage, createTask, getTaskView, patchTask, recordAgentQuestion } = await import("../src/lib/db");
  createTask("task-question", "洗发水研究");
  addMessage("task-question", "user", "帮我研究洗发水");
  recordAgentQuestion("task-question", "evt-ask-platform", "请问要研究哪个平台？");
  recordAgentQuestion("task-question", "evt-ask-platform", "请问要研究哪个平台？");
  assert.equal(getTaskView("task-question")?.pendingQuestion, "请问要研究哪个平台？");
  addMessage("task-question", "user", "京东");
  patchTask("task-question", { status: "running", pending_tool_id: null, pending_question: null });
  const view = getTaskView("task-question");
  assert.deepEqual(view?.messages.map((message) => [message.role, message.text]), [
    ["user", "帮我研究洗发水"], ["question", "请问要研究哪个平台？"], ["user", "京东"],
  ]);
  assert.equal(view?.pendingQuestion, null);
});

test("仅接受已获批远端 MCP Run 的结果，并保留口径和来源", async () => {
  const { getProducts, getTaskView } = await import("../src/lib/db");
  const { publishRemoteResults } = await import("../src/lib/remote-mcp");
  const products = Array.from({ length: 20 }, (_, index) => ({
    platform: "jd", productId: String(index + 1), name: `洗发水${index + 1}`,
    url: index === 0 ? "javascript:alert(1)" : `https://item.jd.com/${index + 1}.html`,
    currentPriceCny: 30 + index, salesRaw: index === 0 ? "热卖榜第2名" : null,
    salesMetricType: index === 0 ? "真实成交量" : null,
    rankingBasis: "京东 popularity 搜索排序", reviewSamples: ["原文评论"],
  }));
  const result = publishRemoteResults("task-mcp", {
    platform: "jd", keyword: "洗发水", actorId: "zen-studio/jd-com-search-scraper",
    runId: "remote-run", datasetId: "remote-dataset", actualCostUsd: 0.8884,
    targetCount: 20, products,
  });
  assert.equal(result.acceptedCount, 20);
  assert.equal(getTaskView("task-mcp")?.apifySpentUsd, 0.8884);
  assert.equal(getProducts("task-mcp")[0].url, "https://item.jd.com/1.html");
  assert.equal(getProducts("task-mcp")[0].salesMetricType, "销量口径未独立核实");
  await assert.rejects(async () => publishRemoteResults("task-mcp", { platform: "jd", keyword: "洗发水", actorId: "wrong/actor", runId: "remote-run", products: [products[0]] }), /Actor/);
});

test("Qoder SSE 断点游标只交付完整事件", async () => {
  const { streamEvents } = await import("../src/lib/qoder");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("Last-Event-ID"), "evt-before");
    return new Response([
      ": heartbeat\n\n",
      "id: evt-1\nevent: event_start\ndata: {\"type\":\"event_start\",\"event\":{\"id\":\"evt-1\"}}\n\n",
      "id: evt-1\nevent: event_delta\ndata: {\"type\":\"event_delta\",\"event_id\":\"evt-1\"}\n\n",
      "id: evt-1\nevent: agent.message\ndata: {\"id\":\"evt-1\",\"type\":\"agent.message\",\"content\":[{\"type\":\"text\",\"text\":\"完成\"}]}\n\n",
    ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  };
  try {
    const received = [];
    for await (const event of streamEvents("sess-test", "evt-before")) received.push(event);
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "agent.message");
  } finally { globalThis.fetch = originalFetch; }
});
