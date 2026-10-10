"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Product, TaskView } from "@/lib/types";

type TaskSummary = { id: string; title: string; status: string; phase: string; created_at: string; updated_at: string };
type Health = { qoderConfigured: boolean; apifyConfigured: boolean; localOnly: boolean };
type ActorStatus = { platform: string; status: string; resultCount: number };

const EXAMPLES = [
  { label: "京东洗发水", prompt: "帮我研究京东平台洗发水品类销量排序前20的商品，整理价格、促销和消费者评价，并明确销量数据的口径。" },
  { label: "天猫护肤品", prompt: "分析天猫护肤品热销商品前20，比较品牌、价格区间、活动和评价反馈。" },
  { label: "淘宝洗面奶", prompt: "获取淘宝洗面奶品类的20个热销商品，关注价格、促销方式及消费者常见意见。" },
];

function money(value: number) { return `$${value.toFixed(3)}`; }
function date(value: string) { return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function platform(value: string) { return value === "jd" ? "京东" : value === "jd-备用" ? "京东备用" : value === "tmall" ? "天猫" : value === "taobao" ? "淘宝" : "平台未核实"; }
function text(value: string | number | null | undefined) { return value === null || value === undefined || value === "" ? "未提供" : String(value); }
function statusName(status: string) {
  return ({ starting: "准备中", running: "进行中", waiting: "待回答", completed: "已完成", failed: "失败", cancelled: "已取消" } as Record<string, string>)[status] || status;
}

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json", ...options?.headers }, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body as T;
}

function ProductRow({ product }: { product: Product }) {
  const [open, setOpen] = useState(false);
  return <>
    <tr className="product-row" onClick={() => setOpen(!open)}>
      <td><span className="rank">{product.rank || "—"}</span></td>
      <td className="product-main"><strong>{product.name}</strong><small>{platform(product.platform)} · {text(product.brand)}</small></td>
      <td className="price">{product.currentPriceCny === null ? "未提供" : `¥${product.currentPriceCny.toFixed(2)}`}</td>
      <td><span className="metric">{text(product.salesRaw)}</span><small>{text(product.salesMetricType)}</small></td>
      <td>{text(product.promotion)}</td>
      <td>{text(product.reviewCount ?? product.reviewCountRaw)}</td>
      <td><span className="row-toggle">{open ? "收起" : "详情"} {open ? "⌃" : "⌄"}</span></td>
    </tr>
    {open && <tr className="detail-row"><td colSpan={7}><div className="detail-grid">
      <div><span className="detail-label">商品链接</span>{product.url ? <a href={product.url} target="_blank" rel="noreferrer">打开原始商品页 ↗</a> : "未提供"}</div>
      <div><span className="detail-label">规格 / SKU</span>{text(product.specification)} / {text(product.sku)}</div>
      <div><span className="detail-label">原价</span>{product.originalPriceCny === null ? "未提供" : `¥${product.originalPriceCny.toFixed(2)}`}</div>
      <div><span className="detail-label">排名依据</span>{text(product.rankingBasis)}</div>
      <div><span className="detail-label">来源</span>{product.sourceActor} · Run {product.sourceRunId}</div>
      <div><span className="detail-label">采集时间</span>{date(product.capturedAt)}</div>
    </div><div className="review-section"><span className="detail-label">代表性评论样本</span>
      {product.reviewSamples.length ? <ul>{product.reviewSamples.map((review, index) => <li key={index}>{review}</li>)}</ul> : <p>暂无可用评论样本</p>}
    </div></td></tr>}
  </>;
}

export default function Home() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskView | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [actorStatuses, setActorStatuses] = useState<ActorStatus[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seenTaskRef = useRef<string | null>(null);

  const loadTasks = useCallback(async () => {
    try { setTasks((await json<{ tasks: TaskSummary[] }>("/api/tasks")).tasks); } catch (error) { setError(String(error)); }
  }, []);
  const loadTask = useCallback(async (id: string) => {
    try { setTask((await json<{ task: TaskView }>(`/api/tasks/${id}`)).task); } catch (error) { setError(String(error)); }
  }, []);

  useEffect(() => {
    const saved = new URLSearchParams(window.location.search).get("task");
    if (saved) setActiveId(saved);
    void loadTasks();
    void json<Health>("/api/health").then(setHealth).catch(() => undefined);
    void json<{ actors: ActorStatus[] }>("/api/actors").then((result) => setActorStatuses(result.actors)).catch(() => undefined);
  }, [loadTasks]);
  useEffect(() => {
    if (!activeId) { setTask(null); return; }
    void loadTask(activeId);
    const source = new EventSource(`/api/tasks/${activeId}/events`);
    source.addEventListener("update", () => { void loadTask(activeId); void loadTasks(); });
    const fallback = setInterval(() => { void loadTask(activeId); }, 15_000);
    return () => { source.close(); clearInterval(fallback); };
  }, [activeId, loadTask, loadTasks]);
  useEffect(() => {
    if (!task) return;
    if (seenTaskRef.current === task.id) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    else seenTaskRef.current = task.id;
  }, [task?.id, task?.messages.length, task?.pendingQuestion]);

  function select(id: string | null) {
    setActiveId(id);
    setTask(null);
    setDraft("");
    setError(null);
    setSidebarOpen(false);
    window.history.replaceState(null, "", id ? `/?task=${id}` : "/");
  }

  async function submit() {
    const value = draft.trim();
    if (!value || busy) return;
    setBusy(true); setError(null);
    try {
      if (!activeId) {
        const result = await json<{ task: TaskView }>("/api/tasks", { method: "POST", body: JSON.stringify({ prompt: value }) });
        setTask(result.task); setDraft(""); select(result.task.id); void loadTasks();
      } else if (task?.status === "waiting") {
        const result = await json<{ task: TaskView }>(`/api/tasks/${activeId}/answer`, { method: "POST", body: JSON.stringify({ answer: value }) });
        setTask(result.task); setDraft("");
      } else {
        const result = await json<{ task: TaskView }>(`/api/tasks/${activeId}/messages`, { method: "POST", body: JSON.stringify({ message: value }) });
        setTask(result.task); setDraft("");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "提交失败"); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!activeId || busy) return;
    setBusy(true); setError(null);
    try { setTask((await json<{ task: TaskView }>(`/api/tasks/${activeId}/cancel`, { method: "POST", body: "{}" })).task); void loadTasks(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "取消失败"); }
    finally { setBusy(false); }
  }

  const canType = !task || Boolean(task.qoderSessionId) && (task.status === "waiting" || task.status === "completed" || task.status === "failed");
  const disabledReason = task && !task.qoderSessionId ? "这是 Actor 直连验证记录；请新建研究任务与 Agent 对话" : task?.status === "running" || task?.status === "starting" ? "Agent 正在执行，请等待结果或回答问题" : task?.status === "cancelled" ? "任务已取消，请新建任务" : null;
  const amount = useMemo(() => task?.products.length || 0, [task?.products.length]);

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="brand"><div className="brand-mark"><span>◎</span></div><div><strong>Commerce Lab</strong><small>Qoder × Apify</small></div></div>
      <button className="new-task" onClick={() => select(null)}><span>＋</span> 新建研究任务</button>
      <div className="side-heading">研究记录 <span>{tasks.length}</span></div>
      <div className="task-list">{tasks.map((item) => <button key={item.id} className={`task-item ${activeId === item.id ? "active" : ""}`} onClick={() => select(item.id)}>
        <span className="task-title">{item.title}</span><span className="task-meta">{date(item.created_at)} <i className={`dot ${item.status}`} /> {statusName(item.status)}</span>
      </button>)}</div>
      <div className="sidebar-foot"><a className="activity-link" href={activeId ? `/activity?task=${activeId}` : "/activity"} target="_blank" rel="noopener noreferrer"><span>⌁</span> Agent 执行轨迹 <b>↗</b></a><div className="local-badge"><i /> 本地工作空间</div><p>凭证仅由本机后端使用</p></div>
    </aside>
    {sidebarOpen && <button className="sidebar-shade" aria-label="关闭菜单" onClick={() => setSidebarOpen(false)} />}

    <main className="main-panel">
      <header className="topbar"><div className="topbar-left"><button className="menu-button" onClick={() => setSidebarOpen(true)} aria-label="打开菜单">☰</button><span className="eyebrow">电商研究工作台</span><span className="top-divider" /><span className="top-title">{task ? task.title : "新的研究"}</span></div><div className="topbar-right"><span className={`engine-dot ${health?.qoderConfigured ? "ready" : ""}`} />{health === null ? "正在检查 Qoder 配置" : health.qoderConfigured ? "Qoder 凭证已配置" : "Qoder 尚未接入"}</div></header>

      <div className="main-scroll">
        {!task && <section className="welcome">
          <div className="hero-icon">✳</div><div className="hero-kicker">RESEARCH, ORGANIZED</div>
          <h1>用一个问题，开始<br /><em>更清楚的电商研究。</em></h1>
          <p>描述平台、商品品类和关心的数据。Agent 会澄清必要信息、选择采集工具，并把来源与销量口径一起交给你。</p>
          <div className="example-title">试试这些研究问题 <span className="example-note">Actor 能力以实测状态为准</span></div><div className="example-grid">{EXAMPLES.map((example) => <button key={example.label} onClick={() => setDraft(example.prompt)}><span className="example-spark">✦</span><strong>{example.label}</strong><span>{example.prompt}</span><b>开始提问 ↗</b></button>)}</div>
          {actorStatuses.length > 0 && <div className="actor-statuses">{actorStatuses.map((actor) => <span key={actor.platform}>{platform(actor.platform)}：{actor.platform === "jd" ? "远端 MCP 20 件已验证" : actor.status === "partial-search" ? `历史探查 ${actor.resultCount} 件，远端待验` : actor.status === "verified-search" ? "历史探查已验证，远端待验" : "候选，待实测"}</span>)}</div>}
          {health && (!health.qoderConfigured || !health.apifyConfigured) && <div className="setup-banner"><strong>{!health.qoderConfigured ? "Qoder 尚未接入" : "远端 Apify MCP 尚未绑定"}</strong><span>当前只能查看旧版 Apify 直连验证数据。创建 Qoder PAT、配置远端 Agent 与 Vault 后才能提交新研究任务；本地应用不会直接调用 Apify。</span></div>}
        </section>}

        {task && <div className="conversation">
          <div className="conversation-intro"><div className="intro-icon">✳</div><div><span>{task.qoderSessionId ? "Qoder Cloud Agent 研究会话" : "旧版直连验证 · 不计验收"}</span><h2>{task.title}</h2><p>{task.qoderSessionId ? "Agent 会保留上下文；后续追问优先使用已有数据。" : "这份数据由旧版本地 Apify 直连测试取得，不代表远端 Agent + MCP 链路已完成。"}</p></div></div>
          <div className="status-panel"><div className="status-top"><div><i className={`status-orb ${task.status}`} /><strong>{statusName(task.status)}</strong><span>{task.phase}</span></div>{(task.status === "running" || task.status === "waiting") && <button className="cancel-button" onClick={cancel} disabled={busy}>取消任务</button>}</div>
            <div className="status-bottom"><span>Qoder Credits <strong>{!task.qoderSessionId ? "未使用" : task.qoderCredits === null ? "统计中" : `${task.qoderCredits.toFixed(2)} / 200`}</strong></span><span>Apify 费用 <strong>{task.apifySpentUsd === null ? "待 MCP 返回实际费用" : money(task.apifySpentUsd)} / $2.000</strong></span><span>商品 <strong>{amount} 件</strong></span></div>
            {task.qoderSessionId && <p className="budget-note">Qoder 预算在下一轮消息前检查，当前执行轮次可能超过 200 Credits。</p>}
          </div>

          <div className="messages">{task.messages.map((message) => <div key={message.id} className={`message ${message.role}`}><div className="message-avatar">{message.role === "user" ? "我" : message.role === "agent" || message.role === "question" ? "✳" : "i"}</div><div className="message-body"><div className="message-head"><strong>{message.kind === "question" ? "研究 Agent · 追问" : message.role === "user" ? "你" : message.role === "agent" ? "研究 Agent" : "系统"}</strong><time>{date(message.createdAt)}</time></div><div className="message-text">{message.role === "agent" ? <ReactMarkdown>{message.text}</ReactMarkdown> : message.text}</div></div></div>)}</div>
          {task.error && <div className="error-card"><strong>任务遇到问题</strong><span>{task.error}</span></div>}

          {task.products.length > 0 && <section className="results"><div className="section-head"><div><span className="section-kicker">STRUCTURED RESULTS</span><h3>商品数据 <b>{task.products.length}</b></h3><p>每项保留来源、采集时间与实际销量口径。</p></div><a className="export-button" href={`/api/tasks/${task.id}/export`}>↓ 导出 CSV</a></div>
            <div className="table-wrap"><table><thead><tr><th>序号</th><th>商品 / 品牌</th><th>现价</th><th>销量指标</th><th>促销</th><th>评价数</th><th></th></tr></thead><tbody>{task.products.map((product) => <ProductRow key={`${product.platform}-${product.productId}`} product={product} />)}</tbody></table></div>
            <div className="table-note">提示：页面展示销量、平台排序和真实成交量不是同一指标；请按每行的“排名依据”解读。</div>
          </section>}
          <div ref={bottomRef} />
        </div>}
      </div>

      <div className="composer-zone">{task?.pendingQuestion && <div className="question-card" role="status" aria-live="polite"><div className="question-kicker">Agent 正在等你回答</div><strong>{task.pendingQuestion}</strong><p>在下方回复后，Agent 会继续这个会话；问题和回答都会保留在聊天记录中。</p></div>}<div className="composer"><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} disabled={!canType || busy} placeholder={task?.status === "waiting" ? "在这里回答 Agent 的问题…" : task ? "基于这次研究继续追问…" : "例如：帮我分析京东洗发水销量排序前20的商品…"} rows={2} /><button className="send-button" onClick={() => void submit()} disabled={!draft.trim() || busy || !canType} aria-label="发送">{busy ? "…" : "↑"}</button></div><div className="composer-hint"><span>{disabledReason || "Enter 发送 · Shift + Enter 换行"}</span><span>本地仅调用 Qoder · 默认 20 件 · MCP 单次上限 $2</span></div>{error && <div className="inline-error">{error}</div>}</div>
    </main>
  </div>;
}
