import { createSession, getSession, listEvents, sendMessage, sendToolResult } from "../src/lib/qoder";

async function main() {
  const session = await createSession("ask_user 联调测试");
  await sendMessage(session.id, "为了测试应用交互，请先调用 ask_user，询问我想研究京东还是天猫。收到回答后，只回复‘联调完成：京东’，不要调用采集工具。");
  let cursor: string | undefined;
  let answered = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    const events = await listEvents(session.id, cursor);
    for (const event of events) {
      cursor = event.id;
      if (event.type === "agent.custom_tool_use" && event.name === "ask_user" && !answered) {
        await sendToolResult(session.id, event.id, "京东");
        answered = true;
      }
      if (event.type === "agent.message") {
        const response = (event.content || []).map((part) => part.text || "").join(" ");
        if (response.includes("联调完成")) {
          const info = await getSession(session.id);
          console.log(JSON.stringify({ sessionId: session.id, askedUser: answered, resumed: true, qoderCredits: info.usage?.total_credits ?? null }));
          return;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`72 秒内未完成交互；Session ${session.id}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "联调失败"); process.exitCode = 1; });
