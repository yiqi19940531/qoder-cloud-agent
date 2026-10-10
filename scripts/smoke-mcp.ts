import { createSession, listEvents, sendMessage } from "../src/lib/qoder";

async function main() {
  const session = await createSession("Apify MCP 只读连通性测试");
  await sendMessage(session.id, "仅通过你在 Qoder 远端连接的 Apify MCP 调用 search-actors，查询 JD.com 商品搜索 Actor；不要调用 call-actor 或其他付费工具。返回一个候选 Actor 名称即可。");
  let cursor: string | undefined;
  let usedMcp = false;
  let gotMcpResult = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    const events = await listEvents(session.id, cursor);
    for (const event of events) {
      cursor = event.id;
      if (event.type === "agent.mcp_tool_use") usedMcp = true;
      if (event.type === "agent.mcp_tool_result") gotMcpResult = true;
      if (event.type === "session.status_idle" && event.stop_reason?.type !== "requires_action" && (usedMcp || gotMcpResult)) {
        console.log(JSON.stringify({ sessionId: session.id, usedRemoteApifyMcp: usedMcp, receivedMcpResult: gotMcpResult, completed: true }));
        if (!usedMcp || !gotMcpResult) process.exitCode = 1;
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`远端 Apify MCP 测试超时；Session ${session.id}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "MCP 联调失败"); process.exitCode = 1; });
