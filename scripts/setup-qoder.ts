import fs from "node:fs";
import { qoderRequest } from "../src/lib/qoder";

const AGENT_NAME = "Ecommerce Research Agent";
const ENV_NAME = "ecommerce-research-runtime";
const VAULT_NAME = "commerce-research-apify-mcp";
const MCP_URL = "https://mcp.apify.com?tools=search-actors,fetch-actor-details,call-actor";

const system = `你是电商商品研究 Agent。用户只与你在 Web 聊天窗口交互；你在 Qoder Cloud Agents 远端执行采集。所有商品采集必须通过你已连接的 Apify MCP Server。客户端只负责 Qoder Session、用户追问和保存展示结果，绝不直接调用 Apify API。
执行规则：
1. 缺少平台或品类关键词时调用 ask_user。商品目标数默认20。除必要信息外不要反复追问。
2. 先调用 list_actors 查看已经实测的 Actor 和输入示例。需要时用 Apify MCP 的 search-actors、fetch-actor-details 查看元数据。首选京东 zen-studio/jd-com-search-scraper；淘宝/天猫可用 zen-studio/taobao-search-scraper，但当前账号可能仅返回10件且平台标识不全。未经验证的 Actor 不要当成已支持。
3. 每个研究 Session 最多调用一次 Apify MCP 的 call-actor。将 Actor 输入放入 input，将 maxTotalChargeUsd=2、maxItems=目标件数放入 callOptions；maxReviewsPerItem 不超过10。不得调用其他工具绕过费用限制。需要更多采集时告知用户新建任务或明确调整预算。
4. 京东20件示例：actor='zen-studio/jd-com-search-scraper'，input={keyword:'洗发水',maxItems:20,sort:'popularity',enrichWithDetails:true,fetchReviews:true,maxReviewsPerItem:10}，callOptions={maxItems:20,maxTotalChargeUsd:2,timeout:300}。淘宝/天猫 sort='sales'，天猫 tmallOnly=true。一次运行结束后用 get-actor-run 查看状态和可用的实际费用，用 get-dataset-items 读取同一 Dataset，不要重复运行 Actor。MCP 返回 persisted-output 文件路径时，可以用内置 Read 读取该远端临时文件；不要用 Bash/Write。
5. 采集完成后必须调用 publish_results 将结构化商品、runId、datasetId、来源、采集时间、销量口径和实际费用（如 MCP 可获取）发送给客户端。最多发布目标件数；字段没有数据则用 null，不能编造。随后给出中文自然语言分析。
6. 销量必须区分真实成交量、页面展示销量区间、平台搜索排序和商品子榜单位置。京东 popularity 排序不是销量 Top20；淘宝/天猫 sales 排序也不能声称为独立核实的真实成交量。isTmall 缺失时平台写 unknown。评论样本不足时明确说明。
7. 对同一个 Session 的追问先调用 load_saved_data，不再发起付费 Actor 运行。若工具失败或费用耗尽，报告已取得的部分结果和原因。不要泄露凭证。`;

const productProperties = {
  platform: { type: "string", enum: ["jd", "taobao", "tmall", "unknown"] },
  productId: { type: "string" }, name: { type: "string" }, brand: { type: ["string", "null"] },
  url: { type: ["string", "null"] }, category: { type: ["string", "null"] },
  specification: { type: ["string", "null"] }, sku: { type: ["string", "null"] },
  currentPriceCny: { type: ["number", "null"] }, originalPriceCny: { type: ["number", "null"] },
  promotion: { type: ["string", "null"] }, salesRaw: { type: ["string", "null"] },
  salesMetricType: { type: ["string", "null"] }, rankingBasis: { type: ["string", "null"] },
  rank: { type: ["integer", "null"] }, reviewCount: { type: ["number", "null"] },
  reviewCountRaw: { type: ["string", "null"] }, rating: { type: ["number", "null"] },
  reviewSamples: { type: "array", items: { type: "string" }, maxItems: 10 },
  capturedAt: { type: "string" },
};

const tools = [
  {
    type: "agent_toolset_20260401", enabled_tools: ["Read"],
    configs: [{ name: "Read", permission_policy: { type: "always_allow" } }],
  },
  {
    type: "mcp_toolset", mcp_server_name: "apify",
    configs: [
      { name: "search-actors", permission_policy: { type: "always_allow" } },
      { name: "fetch-actor-details", permission_policy: { type: "always_allow" } },
      { name: "call-actor", permission_policy: { type: "always_ask" } },
      { name: "get-actor-run", permission_policy: { type: "always_allow" } },
      { name: "get-dataset-items", permission_policy: { type: "always_allow" } },
      { name: "abort-actor-run", permission_policy: { type: "always_deny" } },
    ],
  },
  { type: "custom", name: "ask_user", description: "向终端用户询问完成当前任务必需的信息并等待回复。", input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
  { type: "custom", name: "list_actors", description: "读取当前应用已登记 Actor 的平台、输入示例和实测状态；这不会调用 Apify API。", input_schema: { type: "object", properties: {} } },
  { type: "custom", name: "load_saved_data", description: "读取本任务已经发布的商品，用于追问时复用，不再付费采集。", input_schema: { type: "object", properties: {} } },
  {
    type: "custom", name: "publish_results", description: "把已由远端 Apify MCP 采集并处理的商品与来源发送给客户端保存展示。",
    input_schema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["jd", "taobao", "tmall"] }, keyword: { type: "string" },
        actorId: { type: "string" }, runId: { type: "string" }, datasetId: { type: ["string", "null"] },
        actualCostUsd: { type: ["number", "null"] }, targetCount: { type: "integer" },
        analysisNote: { type: "string" },
        products: { type: "array", items: { type: "object", properties: productProperties, required: ["platform", "productId", "name"] } },
      },
      required: ["platform", "keyword", "actorId", "runId", "products"],
    },
  },
];

function updateEnv(values: Record<string, string>) {
  const path = ".env.local";
  const current = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
  let updated = current;
  for (const [key, value] of Object.entries(values)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    updated = regex.test(updated) ? updated.replace(regex, `${key}=${value}`) : `${updated.trimEnd()}\n${key}=${value}\n`;
  }
  fs.writeFileSync(path, updated, { mode: 0o600 });
  fs.chmodSync(path, 0o600);
}

async function main() {
  const models = await qoderRequest<{ data: Array<{ id: string; display_name?: string }> }>("/models");
  const findModel = (name: string) => models.data.find((item) => `${item.id} ${item.display_name || ""}`.toLowerCase().includes(name.toLowerCase()));
  const model = findModel("Qwen3.8-Max") || findModel("Qwen3.8-Flash") || findModel("ultimate");
  if (!model) throw new Error("当前账号没有 Qwen3.8-Max、Qwen3.8-Flash 或 ultimate 可用模型。");

  const environments = await qoderRequest<{ data: Array<{ id: string; name: string }> }>("/environments?limit=100");
  let environment = environments.data.find((item) => item.name === ENV_NAME);
  if (!environment) environment = await qoderRequest<{ id: string; name: string }>("/environments", { method: "POST", body: JSON.stringify({ name: ENV_NAME, config: { type: "cloud" } }) });

  const vaults = await qoderRequest<{ data: Array<{ id: string; display_name: string }> }>("/vaults?limit=100");
  let vault = vaults.data.find((item) => item.display_name === VAULT_NAME);
  if (!vault) vault = await qoderRequest<{ id: string; display_name: string }>("/vaults", { method: "POST", body: JSON.stringify({ display_name: VAULT_NAME, metadata: { purpose: "Apify MCP for ecommerce research" } }) });
  const credentials = await qoderRequest<{ data: Array<{ auth?: { mcp_server_url?: string } }> }>(`/vaults/${vault.id}/credentials?limit=100`);
  const hasCredential = credentials.data.some((credential) => credential.auth?.mcp_server_url === MCP_URL);
  if (!hasCredential) {
    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) throw new Error("创建远端 Vault 凭证需要一次性 APIFY_API_TOKEN；请把它放在未入库的 .env.local 中后重试。");
    await qoderRequest(`/vaults/${vault.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({ auth: { type: "static_bearer", mcp_server_url: MCP_URL, token: apifyToken }, metadata: { purpose: "commerce-research" } }),
    });
  }

  const config = {
    name: AGENT_NAME,
    description: "通过远端 Apify MCP 采集京东、淘宝和天猫商品，并将结果交回 Web 客户端。",
    model: model.id,
    system,
    tools,
    mcp_servers: [{ type: "url", name: "apify", url: MCP_URL }],
  };
  const agents = await qoderRequest<{ data: Array<{ id: string; name: string; version: number }> }>("/agents?limit=100");
  let agent = agents.data.find((item) => item.name === AGENT_NAME);
  if (agent) {
    agent = await qoderRequest<{ id: string; name: string; version: number }>(`/agents/${agent.id}`, {
      method: "POST", body: JSON.stringify({ version: agent.version, description: config.description, model: config.model, system: config.system, tools: config.tools, mcp_servers: config.mcp_servers }),
    });
  } else {
    agent = await qoderRequest<{ id: string; name: string; version: number }>("/agents", { method: "POST", body: JSON.stringify(config), headers: { "Idempotency-Key": "ecommerce-research-agent-remote-mcp-v2" } });
  }

  updateEnv({ QODER_AGENT_ID: agent.id, QODER_ENVIRONMENT_ID: environment.id, QODER_APIFY_VAULT_ID: vault.id, QODER_APIFY_MCP_READY: "true", APIFY_API_TOKEN: "" });
  console.log(JSON.stringify({ model: model.display_name || model.id, agentId: agent.id, agentVersion: agent.version, environmentId: environment.id, vaultId: vault.id, mcpUrl: MCP_URL, apifyTokenRemovedFromLocalRuntime: true }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Qoder 远端配置失败"); process.exitCode = 1; });
