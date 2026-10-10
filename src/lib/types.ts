export type TaskStatus =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export type Platform = "jd" | "taobao" | "tmall" | "unknown";
export type ActorOperation = "search" | "detail" | "reviews";

export interface Product {
  platform: Platform;
  productId: string;
  name: string;
  brand: string | null;
  url: string | null;
  category: string | null;
  specification: string | null;
  sku: string | null;
  currentPriceCny: number | null;
  originalPriceCny: number | null;
  promotion: string | null;
  salesRaw: string | null;
  salesMetricType: string | null;
  rankingBasis: string | null;
  rank: number | null;
  reviewCount: number | null;
  reviewCountRaw?: string | null;
  rating: number | null;
  reviewSamples: string[];
  capturedAt: string;
  sourceActor: string;
  sourceRunId: string;
  sourceDatasetId: string | null;
  status: "complete" | "partial";
}

export interface TaskView {
  id: string;
  qoderSessionId: string | null;
  title: string;
  status: TaskStatus;
  phase: string;
  pendingQuestion: string | null;
  error: string | null;
  qoderCredits: number | null;
  apifyBudgetUsd: number;
  apifySpentUsd: number | null;
  products: Product[];
  messages: Array<{ id: number; role: "user" | "agent" | "system" | "question"; text: string; createdAt: string; kind?: "message" | "question" }>;
  createdAt: string;
  updatedAt: string;
}

export interface QoderEvent {
  id: string;
  type: string;
  content?: Array<{ type: string; text?: string }>;
  name?: string;
  input?: Record<string, unknown>;
  stop_reason?: { type?: string; event_ids?: string[] };
  total_credits?: number;
  processed_at?: string;
  [key: string]: unknown;
}

export interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId?: string;
  usageTotalUsd?: number | null;
  finishedAt?: string | null;
  statusMessage?: string | null;
}
