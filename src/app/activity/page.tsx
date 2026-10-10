"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { TracePayload, TraceStep } from "@/lib/trace";

type TaskSummary = {
  id: string; title: string; status: string; phase: string;
  created_at: string; has_qoder_session: number;
};
type TraceResponse = {
  task: { id: string; title: string; status: string; phase: string; sessionId: string; credits: number | null };
  steps: TraceStep[];
  counts: { totalEvents: number; toolCalls: number; completedTools: number; failedTools: number };
  lastEventId: string | null;
};

function when(value: string | null) {
  if (!value) return "时间未提供";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "时间未提供" : parsed.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusLabel(status: string | undefined) {
  return ({ running: "执行中", waiting: "等待处理", success: "已返回", error: "失败", denied: "已拒绝", completed: "已完成", failed: "失败" } as Record<string, string>)[status || ""] || "待返回";
}

function payloadBlock(label: string, value: TracePayload | undefined) {
  if (!value) return null;
  return <details className="trace-payload"><summary>{label}{value.truncated ? ` · 已截取 ${value.text.length}/${value.totalChars} 字符` : ""}</summary><pre>{value.text || "（空）"}</pre></details>;
}

function StepCard({ step, index }: { step: TraceStep; index: number }) {
  if (step.kind === "tool") return <article className={`trace-step trace-tool ${step.status || "running"}`}>
    <div className="trace-rail"><span>{index + 1}</span></div>
    <div className="trace-step-body">
      <div className="trace-step-top"><span className="trace-provider">{step.provider || "工具结果"}</span><time>{when(step.at)}</time></div>
      <div className="trace-step-heading"><h3>{step.title}</h3><span className={`trace-state ${step.status || "running"}`}>{statusLabel(step.status)}</span></div>
      <div className="trace-meta">事件 {step.id}{step.durationMs !== undefined ? ` · 耗时 ${(step.durationMs / 1000).toFixed(1)} 秒` : ""}{step.approval ? ` · ${step.approval === "allow" ? "已批准调用" : "调用被拒绝"}` : ""}</div>
      {payloadBlock("调用参数", step.input)}
      {payloadBlock("工具返回", step.output)}
    </div>
  </article>;

  if (step.kind === "thinking" || step.kind === "session" || step.kind === "usage") return <article className={`trace-step trace-compact ${step.kind}`}>
    <div className="trace-rail"><span>{index + 1}</span></div>
    <div className="trace-step-body"><div className="trace-step-top"><strong>{step.title}</strong><time>{when(step.at)}</time></div>{step.detail && <p>{step.detail.text}</p>}</div>
  </article>;

  return <article className={`trace-step trace-note ${step.kind}`}>
    <div className="trace-rail"><span>{index + 1}</span></div>
    <div className="trace-step-body">
      <div className="trace-step-top"><strong>{step.title}</strong><time>{when(step.at)}</time></div>
      {step.detail && <><p>{step.detail.text.slice(0, 240)}{step.detail.text.length > 240 ? "…" : ""}</p>{step.detail.text.length > 240 && payloadBlock("查看这一步的完整公开内容", step.detail)}</>}
    </div>
  </article>;
}

export default function ActivityPage() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [filter, setFilter] = useState<"all" | "tool" | "steps">("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/tasks", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`任务列表 HTTP ${response.status}`);
      return response.json() as Promise<{ tasks: TaskSummary[] }>;
    }).then(({ tasks: all }) => {
      if (!active) return;
      const remote = all.filter((item) => item.has_qoder_session);
      setTasks(remote);
      const requested = new URLSearchParams(window.location.search).get("task");
      setSelectedId(remote.find((item) => item.id === requested)?.id || remote[0]?.id || null);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "任务列表读取失败"); });
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/tasks/${id}/trace`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (new URLSearchParams(window.location.search).get("task") === id) {
        setTrace(body as TraceResponse);
        setUpdatedAt(new Date().toISOString());
        setError(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "轨迹读取失败");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    window.history.replaceState(null, "", `/activity?task=${selectedId}`);
    setTrace(null); setError(null);
    void refresh(selectedId);
  }, [selectedId, refresh]);

  useEffect(() => {
    if (!selectedId) return;
    const intervalMs = trace?.task.status === "running" || trace?.task.status === "waiting" ? 5_000 : 15_000;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(selectedId, true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [selectedId, refresh, trace?.task.status]);

  const visible = useMemo(() => (trace?.steps || []).filter((step) => {
    if (filter === "tool" && step.kind !== "tool") return false;
    if (filter === "steps" && step.kind === "tool") return false;
    const needle = search.trim().toLowerCase();
    return !needle || `${step.title} ${step.provider || ""} ${step.eventType}`.toLowerCase().includes(needle);
  }), [trace?.steps, filter, search]);

  return <div className="trace-shell">
    <aside className="trace-sidebar">
      <div className="trace-brand"><span className="trace-brand-mark">◎</span><div><strong>Commerce Lab</strong><small>Qoder · 执行轨迹</small></div></div>
      <a className="trace-back" href={selectedId ? `/?task=${selectedId}` : "/"}>← 返回对话页面</a>
      <div className="trace-side-title">远端 Session <span>{tasks.length}</span></div>
      <div className="trace-task-list">{tasks.map((item) => <button key={item.id} className={selectedId === item.id ? "selected" : ""} onClick={() => setSelectedId(item.id)}>
        <strong>{item.title}</strong><small>{when(item.created_at)} · {statusLabel(item.status)}</small>
      </button>)}</div>
      <div className="trace-side-foot">公开事件由 Qoder Session API 提供。凭证仅由本机后端使用。</div>
    </aside>

    <main className="trace-main">
      <header className="trace-header"><div><span>QODER CLOUD AGENT</span><h1>执行轨迹</h1></div><button onClick={() => selectedId && void refresh(selectedId)} disabled={!selectedId || loading}>↻ 刷新事件</button></header>
      {!selectedId ? <div className="trace-empty">目前没有可查看的 Qoder Cloud Session。</div> : <>
        <section className="trace-overview">
          <div className="trace-overview-head"><div><h2>{trace?.task.title || tasks.find((item) => item.id === selectedId)?.title || "正在读取会话"}</h2><p>Session {trace?.task.sessionId || "读取中"}</p></div><span className="trace-session-status">{statusLabel(trace?.task.status || tasks.find((item) => item.id === selectedId)?.status)}</span></div>
          <div className="trace-stats"><div><small>工具调用</small><strong>{trace?.counts.toolCalls ?? "—"}</strong></div><div><small>已返回</small><strong>{trace?.counts.completedTools ?? "—"}</strong></div><div><small>失败/拒绝</small><strong>{trace?.counts.failedTools ?? "—"}</strong></div><div><small>Qoder Credits</small><strong>{typeof trace?.task.credits === "number" ? trace.task.credits.toFixed(2) : "—"}</strong></div></div>
          <p className="trace-explainer">展示 Qoder 公开事件中的 Agent 消息、工具参数与返回结果。内部推理正文不会由 Qoder API 提供；运行中每 5 秒自动更新。</p>
        </section>

        <section className="trace-timeline">
          <div className="trace-controls"><div className="trace-filters"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部步骤</button><button className={filter === "tool" ? "active" : ""} onClick={() => setFilter("tool")}>仅工具</button><button className={filter === "steps" ? "active" : ""} onClick={() => setFilter("steps")}>Agent / 状态</button></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索工具名或事件类型" aria-label="搜索执行轨迹" /></div>
          <div className="trace-timeline-note">{trace ? `${visible.length} 个可见步骤 · ${trace.counts.totalEvents} 条公开事件` : "正在读取事件"}{updatedAt ? ` · 更新于 ${when(updatedAt)}` : ""}</div>
          {error && <div className="trace-error">{error}</div>}
          {loading && !trace && <div className="trace-empty">正在从 Qoder 读取 Session 事件…</div>}
          {!loading && trace && visible.length === 0 && <div className="trace-empty">此筛选条件下没有事件。</div>}
          <div className="trace-list">{visible.map((step, index) => <StepCard key={step.id} step={step} index={index} />)}</div>
        </section>
      </>}
    </main>
  </div>;
}
