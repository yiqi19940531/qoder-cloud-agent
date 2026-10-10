import { z } from "zod";
import { registeredActorIds } from "./actors";
import { db, now, taskRow, upsertProduct } from "./db";
import type { Product, QoderEvent } from "./types";

const BUDGET_MICROS = 2_000_000;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function inspectPaidMcpCall(event: QoderEvent) {
  const name = String(event.name || "");
  const server = String(event.mcp_server_name || "");
  const isApifyCall = (server === "apify" && name === "call-actor") || /^mcp__apify__call-actor$/.test(name);
  if (!isApifyCall) return { allow: false, reason: `未授权的工具：${name || "unknown"}` } as const;
  const args = object(event.input);
  const actorId = String(args.actor || "").replace("~", "/");
  if (!registeredActorIds().includes(actorId)) return { allow: false, reason: `Actor ${actorId || "unknown"} 未在本应用登记。` } as const;
  const input = object(args.input);
  const callOptions = object(args.callOptions);
  const capUsd = Number(callOptions.maxTotalChargeUsd);
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 2) return { allow: false, reason: "MCP call-actor 必须在 callOptions 中设置不超过 $2 的 maxTotalChargeUsd。" } as const;
  const targetCount = Number(input.maxItems || 20);
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 100) return { allow: false, reason: "商品目标数须在 1–100 之间。" } as const;
  const reviewLimit = Number(input.maxReviewsPerItem || 0);
  if (reviewLimit > 10) return { allow: false, reason: "每件商品最多采集 10 条评论。" } as const;
  const billingItems = Number(callOptions.maxItems || targetCount);
  if (!Number.isInteger(billingItems) || billingItems < 1 || billingItems > 100) return { allow: false, reason: "callOptions.maxItems 须在 1–100 之间。" } as const;
  return { allow: true, actorId, capMicros: Math.floor(capUsd * 1_000_000), targetCount } as const;
}

export function reservePaidMcpCall(taskId: string, event: QoderEvent) {
  const decision = inspectPaidMcpCall(event);
  if (!decision.allow) return decision;
  db.exec("BEGIN IMMEDIATE");
  try {
    const task = taskRow(taskId);
    if (!task || task.status === "cancelled") throw new Error("任务不存在或已取消。");
    const existing = db.prepare("SELECT tool_event_id FROM mcp_calls WHERE task_id=?").get(taskId) as { tool_event_id: string } | undefined;
    if (existing && existing.tool_event_id !== event.id) throw new Error("每个研究任务只允许一次付费 Actor 运行；追问须复用已有 Dataset。");
    if (!existing) {
      db.prepare(`INSERT INTO mcp_calls (task_id,tool_event_id,actor_id,max_charge_micros,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?)`).run(taskId, event.id, decision.actorId, Math.min(decision.capMicros, BUDGET_MICROS), "approved", now(), now());
    }
    db.exec("COMMIT");
    return decision;
  } catch (error) {
    db.exec("ROLLBACK");
    return { allow: false, reason: error instanceof Error ? error.message : "费用许可失败" } as const;
  }
}

const nullableText = z.string().max(2000).nullable().optional();
const productSchema = z.object({
  platform: z.enum(["jd", "taobao", "tmall", "unknown"]),
  productId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(1000),
  brand: nullableText,
  url: nullableText,
  category: nullableText,
  specification: nullableText,
  sku: nullableText,
  currentPriceCny: z.number().nonnegative().nullable().optional(),
  originalPriceCny: z.number().nonnegative().nullable().optional(),
  promotion: nullableText,
  salesRaw: nullableText,
  salesMetricType: nullableText,
  rankingBasis: nullableText,
  rank: z.number().int().positive().nullable().optional(),
  reviewCount: z.number().nonnegative().nullable().optional(),
  reviewCountRaw: nullableText,
  rating: z.number().min(0).max(5).nullable().optional(),
  reviewSamples: z.array(z.string().max(1000)).max(10).optional(),
  capturedAt: z.string().max(100).optional(),
});

export const publishSchema = z.object({
  platform: z.enum(["jd", "taobao", "tmall"]),
  keyword: z.string().trim().min(1).max(100),
  actorId: z.string().min(1),
  runId: z.string().trim().min(1),
  datasetId: z.string().nullable().optional(),
  actualCostUsd: z.number().nonnegative().nullable().optional(),
  targetCount: z.number().int().min(1).max(100).optional(),
  analysisNote: z.string().max(4000).optional(),
  products: z.array(productSchema).min(1).max(100),
});

function safeUrl(platform: Product["platform"], candidate: string | null | undefined, id: string) {
  if (candidate) {
    try {
      const url = new URL(candidate);
      const domain = url.hostname.toLowerCase();
      const valid = platform === "jd" ? domain === "jd.com" || domain.endsWith(".jd.com")
        : ["taobao.com", "tmall.com"].some((root) => domain === root || domain.endsWith(`.${root}`));
      if (url.protocol === "https:" && valid) return url.toString();
    } catch { /* use canonical URL */ }
  }
  return platform === "jd" ? `https://item.jd.com/${encodeURIComponent(id)}.html` : `https://item.taobao.com/item.htm?id=${encodeURIComponent(id)}`;
}

export function publishRemoteResults(taskId: string, raw: unknown) {
  const input = publishSchema.parse(raw);
  const call = db.prepare("SELECT actor_id,run_id FROM mcp_calls WHERE task_id=?").get(taskId) as { actor_id: string; run_id: string | null } | undefined;
  if (!call) throw new Error("当前任务没有经 Qoder Apify MCP 批准的 Actor 运行，拒绝发布结果。");
  if (call.actor_id !== input.actorId) throw new Error("发布结果的 Actor 与获批 MCP 调用不一致。");
  if (call.run_id && call.run_id !== input.runId) throw new Error("发布结果的 Run ID 与已保存记录不一致。");
  if (input.actualCostUsd !== null && input.actualCostUsd !== undefined && input.actualCostUsd > 2) throw new Error("报告费用超出本任务 $2 上限，请核查 Actor Run。");
  const targetCount = input.targetCount ?? 20;
  const unique = new Set<string>();
  const accepted: Product[] = [];
  for (const [index, item] of input.products.entries()) {
    const key = `${item.platform}:${item.productId}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const salesMetricType = item.salesMetricType === "真实成交量" ? "销量口径未独立核实" : item.salesMetricType || (item.salesRaw ? "页面展示指标（口径未核实）" : null);
    const product: Product = {
      platform: item.platform,
      productId: item.productId,
      name: item.name,
      brand: item.brand ?? null,
      url: safeUrl(item.platform, item.url, item.productId),
      category: item.category ?? input.keyword,
      specification: item.specification ?? null,
      sku: item.sku ?? null,
      currentPriceCny: item.currentPriceCny ?? null,
      originalPriceCny: item.originalPriceCny ?? null,
      promotion: item.promotion ?? null,
      salesRaw: item.salesRaw ?? null,
      salesMetricType,
      rankingBasis: item.rankingBasis || "Actor 返回的搜索顺序；未核实真实销量排名",
      rank: item.rank ?? index + 1,
      reviewCount: item.reviewCount ?? null,
      reviewCountRaw: item.reviewCountRaw ?? null,
      rating: item.rating ?? null,
      reviewSamples: (item.reviewSamples || []).slice(0, 10).map((text) => text.slice(0, 500)),
      capturedAt: item.capturedAt && !Number.isNaN(Date.parse(item.capturedAt)) ? item.capturedAt : now(),
      sourceActor: input.actorId,
      sourceRunId: input.runId,
      sourceDatasetId: input.datasetId ?? null,
      status: item.currentPriceCny !== null && item.currentPriceCny !== undefined && item.reviewSamples?.length ? "complete" : "partial",
    };
    accepted.push(product);
    if (accepted.length >= targetCount) break;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const product of accepted) upsertProduct(taskId, product);
    db.prepare("UPDATE mcp_calls SET run_id=?, dataset_id=?, actual_cost_micros=?, status='reported', updated_at=? WHERE task_id=?")
      .run(input.runId, input.datasetId ?? null, input.actualCostUsd == null ? null : Math.ceil(input.actualCostUsd * 1_000_000), now(), taskId);
    if (input.actualCostUsd != null) db.prepare("UPDATE tasks SET apify_spent_micros=?, updated_at=? WHERE id=?")
      .run(Math.ceil(input.actualCostUsd * 1_000_000), now(), taskId);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { acceptedCount: accepted.length, targetCount, runId: input.runId, datasetId: input.datasetId ?? null, costStatus: input.actualCostUsd == null ? "未由 MCP 返回" : "Agent 根据 MCP Run 报告", note: input.analysisNote ?? null };
}
