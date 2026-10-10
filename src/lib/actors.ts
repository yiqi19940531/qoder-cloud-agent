import type { Platform } from "./types";

// Capability registry for the remote Qoder Agent. This module never calls Apify.
export const ACTORS = {
  jd: {
    id: "zen-studio/jd-com-search-scraper",
    description: "京东关键词搜索；单次运行可包含详情和评论。实测 20 件。",
    input: { keyword: "洗发水", maxItems: 20, sort: "popularity", enrichWithDetails: true, fetchReviews: true, maxReviewsPerItem: 10 },
    rankingBasis: "京东 popularity 搜索排序，不能视为真实销量 Top 20",
  },
  taobao: {
    id: "zen-studio/taobao-search-scraper",
    description: "淘宝关键词搜索；当前账号一次仅返回 10 件，部分平台归属不明。",
    input: { keyword: "洗面奶", maxItems: 20, sort: "sales", tmallOnly: false, enrichWithDetails: true, fetchReviews: true, maxReviewsPerItem: 10 },
    rankingBasis: "淘宝 sales 搜索排序；免费方案仅一页，不能视为真实销量 Top 20",
  },
  tmall: {
    id: "zen-studio/taobao-search-scraper",
    description: "天猫过滤搜索；当前账号一次仅返回 10 件，多数结果平台标识不明确。",
    input: { keyword: "护肤品", maxItems: 20, sort: "sales", tmallOnly: true, enrichWithDetails: true, fetchReviews: true, maxReviewsPerItem: 10 },
    rankingBasis: "天猫过滤的搜索结果；只有明确标记 Tmall 的商品可确认为天猫",
  },
} as const;

export const JD_FALLBACK_ACTOR = "silentflow/jd-products-scraper";

export function registeredActors(platform: Exclude<Platform, "unknown">) {
  return platform === "jd" ? [ACTORS.jd.id, JD_FALLBACK_ACTOR] : [ACTORS[platform].id];
}

export function registeredActorIds() {
  return [...new Set([...Object.values(ACTORS).map((actor) => actor.id), JD_FALLBACK_ACTOR])];
}
