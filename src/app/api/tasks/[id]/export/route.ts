import { NextRequest } from "next/server";
import { getProducts, taskRow } from "@/lib/db";
import { localRequestError } from "@/lib/http";

export const runtime = "nodejs";
function cell(value: unknown) {
  let text = value === null || value === undefined || value === "" ? "未提供" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const denied = localRequestError(request);
  if (denied) return denied;
  const { id } = await context.params;
  if (!taskRow(id)) return new Response("Not found", { status: 404 });
  const columns = ["排名", "平台", "商品名称", "品牌", "商品链接", "品类", "规格", "SKU", "现价(元)", "原价(元)", "促销", "销量原始值", "销量口径", "排名依据", "评价数", "评分", "代表性评论", "采集时间", "Actor", "Run ID", "Dataset ID", "采集状态"];
  const rows = getProducts(id).map((product) => [
    product.rank, product.platform, product.name, product.brand, product.url, product.category,
    product.specification, product.sku, product.currentPriceCny, product.originalPriceCny,
    product.promotion, product.salesRaw, product.salesMetricType, product.rankingBasis,
    product.reviewCount ?? product.reviewCountRaw, product.rating, product.reviewSamples.join(" | "), product.capturedAt,
    product.sourceActor, product.sourceRunId, product.sourceDatasetId, product.status,
  ]);
  const csv = `\uFEFF${[columns, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}`;
  return new Response(csv, { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="commerce-research-${id.slice(0, 8)}.csv"`,
  } });
}
