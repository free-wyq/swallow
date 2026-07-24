// orchestrator.ts —— SDK 版 24h 无人值守开发 orchestrator（tick 化 + 事件溯源）
//
// 用法：
//   npx tsx orchestrator.ts [--cwd <项目目录>] "目标"           # 裸跑=--watch（自驱：bootstrap+while(tick)）
//   npx tsx orchestrator.ts [--cwd <项目目录>] --watch "目标"    # 显式自驱
//   npx tsx orchestrator.ts [--cwd <项目目录>] --status         # 多行实时状态（给人看）
//   npx tsx orchestrator.ts [--cwd <项目目录>] --report         # 运行报告
//   npx tsx orchestrator.ts [--cwd <项目目录>] --stop            # 写 .stop 哨兵 + 杀 --watch PID
//   npx tsx orchestrator.ts [--cwd <项目目录>] --resume         # 删 .stop 哨兵
//
// --cwd 指定目标项目目录（产物写入处 + git commit 的仓库 + 会话工作目录）；不传则用当前目录
// 或 LOOP_PROJECT 环境变量。
//
// 会话策略：首轮新会话（query 返回的 session_id 落盘 .session_id），后续轮 resume 同一会话；
// 永不使用 continue（避免旧会话污染）。session_id 由 .session_id 文件单源管理（不进 state.json）。
//
// 设计原则：orchestrator 只管推进 + 把结果结构化落盘（state.json + events.jsonl）。
// 战报/推送由外部 agent 读这些结构化结果自行组织发送，orchestrator 不发战报。
// 推进靠 --watch 长进程（tick 内核 + state/events 落盘，崩溃可恢复），不依赖外部触发。

import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs as nodeParseArgs } from "node:util";
import lockfile from "proper-lockfile";

// write-file-atomic v7 不自带类型且 @types 版本滞后。用 ambient 声明（单独 .d.ts 文件，
// TS 对「untyped module」不允许 inline declare module 增强，必须外置）。见 write-file-atomic.d.ts。
import writeFileAtomic from "write-file-atomic";
const writeAtomic = (path: string, data: string) => writeFileAtomic.sync(path, data);

// ---------------- 启动期：加载 loop.env（调度器友好）----------------
// cron / systemd / hermes cron 这类非交互调度器跑的是干净 env，不会 source ~/.bashrc——
// 用户写在 ~/.bashrc 里的 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 它们根本拿不到
// （实测：调度器里得手 export + sed 抠 ~/.bashrc 才跑得通，极脆、还常触发审批）。
// 放一份 KEY=VALUE 进 ~/.config/loop.env，orchestrator 启动时读进 process.env；
// 已 export 的环境变量优先、不覆盖。LOOP_ENV_FILE 可指到别处。
function loadEnvFileOnce() {
  const path = process.env.LOOP_ENV_FILE || `${homedir()}/.config/loop.env`;
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return; }  // 不存在/读不到就跳过
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') ||
                           (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1);
    }
    if (!key) continue;
    if (process.env[key] === undefined) process.env[key] = val;  // 已 export 的不覆盖
  }
}
loadEnvFileOnce();

// 限额写死在脚本（不读 loop.env）：当前大背景 token 不限量（自托管/免费代理模型无按量计费），
// 预算/轮数护栏纯属挡路 → 一律 0=不限；行为护栏（空转/超时/重试）留正数防死循环。要改改下面的常量。
// 密钥/代理/模型才走 loop.env（见 loadEnvFileOnce）。hasLimit(n)=n>0 让写死的值自洽：0=关、正数=开。
const UNLIMITED = 0;  // 0 表示不限；常量比较时用 hasLimit(n) = n > 0
const hasLimit = (n: number) => n > 0;

// ---------------- 配置 ----------------

const TASK_FILE = ".task.md";
const LOG_FILE = "night_run.log";
const MEMO_DIR = ".claude/memory";
const SESSION_FILE = ".session_id";      // session_id 单源（不进 state.json）
const PID_FILE = ".pid";                // --watch 进程的 PID

// 持久化与锁文件
const STATE_FILE = "state.json";        // 机器读恢复点快照（原子写）
const EVENTS_FILE = "events.jsonl";     // append-only 审计流
const STOP_FILE = ".stop";              // .stop 哨兵：--stop 写，--watch 下次 tick 检测到则退出
const LOCK_FILE = ".tick.lock";          // flock 进程级并发保护（防多 watch / 手动与 watch 并发）

// 限额写死（不读环境变量）：token 不限量场景下，轮数护栏纯属挡路 → 一律 0=不限。
// 行为护栏留正数防死循环（空转/超时/重试）。要改改这里的常量，不必改 loop.env。
const MAX_TURNS_PER_TASK = UNLIMITED;        // 单任务 agentic 轮上限；0=不限（token 不限量）
const STALL_LIMIT = 3;                       // 同任务连续零改动 N 次标阻塞
const ABORT_TIMEOUT_MIN = 60;                // 单任务超 N 分钟无进展则 abort 重试
const SESSION_RETRY_LIMIT = 3;               // 陷阱7：当前任务连续 session_dropped N 次标阻塞（防 ctx-overflow 死循环）
// bootstrap 同样不限。拆解是大目标，限额易崩成拆解失败。
const BOOTSTRAP_MAX_TURNS = UNLIMITED;
// 上下文健康度：上轮 input_tokens 占模型上下文超 CTX_RECYCLE_RATIO → 下轮弃旧会话开新会话
// （防同一 session 跨 tick 累积到撞墙——代理模型上下文有限，resume 进来的 bulk 历史常直接撑爆）。
// 超阈值先试 /compact deep 探针压一轮，没降下来再弃会话。0=不启用。
// （窗口大小不写死——运行时由 getContextUsage 实测，非注释里的某个估计值。）
const CTX_RECYCLE_RATIO = 0.7;
const WATCH_SLEEP_MS = 5_000;       // --watch tick 间隔
const ALREADY_RUNNING_SLEEP_MS = 30_000; // 拿不到锁时的退避
const LOCK_STALE_MS = 60_000;        // 锁 stale 阈值：proper-lockfile 自动检测并 takeover（进程 kill -9 后 60s 可被抢）

// ---------------- 工具函数 ----------------

// 本地时间（跟随系统时区 / TZ 环境变量）。之前用 toISOString() 输出 UTC，
// CST 机器日志显示差 8h（如 04:59 而非 12:59），排查时序时被误导。
const localParts = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    y: d.getFullYear(), mo: p(d.getMonth() + 1), da: p(d.getDate()),
    h: p(d.getHours()), mi: p(d.getMinutes()), s: p(d.getSeconds()),
  };
};
const now = () => {
  const t = localParts();
  return `${t.y}-${t.mo}-${t.da} ${t.h}:${t.mi}:${t.s}`;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// ---- 任务文件读写（.task.md 格式）----

interface Tasks { total: number; remaining: number; done: number; blocked: number; }

// remaining 只数 [ ]，blocked 数 [~]，done 数 [x]——三者各数各的，不互相推导（防阻塞被算进已完成）
function readTasks(): Tasks {
  if (!existsSync(TASK_FILE)) return { total: 0, remaining: 0, done: 0, blocked: 0 };
  const text = readFileSync(TASK_FILE, "utf8");
  let total = 0, rem = 0, done = 0, blocked = 0;
  for (const l of text.split("\n")) {
    const m = l.match(/^- \[([ x~])\]/);
    if (!m) continue;
    total++;
    if (m[1] === " ") rem++;
    else if (m[1] === "x") done++;
    else if (m[1] === "~") blocked++;
  }
  return { total, remaining: rem, done, blocked };
}

function currentTaskLine(): string | null {
  if (!existsSync(TASK_FILE)) return null;
  for (const l of readFileSync(TASK_FILE, "utf8").split("\n")) {
    if (/^- \[ \]/.test(l)) return l;
  }
  return null;
}

function countBlocked(): number {
  return readTasks().blocked;
}

// 陷阱1: 原子写（write-file-atomic 处理 data fsync + dir fsync 顺序，崩溃后元数据不丢）
function atomicWriteFile(path: string, content: string) {
  writeAtomic(path, content);
}

// 把第一个未完成任务行打勾 [ ]→[x]（陷阱1: 原子写）
function tickFirst() {
  const text = readFileSync(TASK_FILE, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) {
      lines[i] = lines[i].replace(/^- \[ \]/, "- [x]");
      atomicWriteFile(TASK_FILE, lines.join("\n"));
      return;
    }
  }
}

// 标记阻塞 [ ]→[~]（陷阱1: 原子写）
function blockFirst() {
  const text = readFileSync(TASK_FILE, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) {
      lines[i] = lines[i].replace(/^- \[ \]/, "- [~]");
      atomicWriteFile(TASK_FILE, lines.join("\n"));
      return;
    }
  }
}

// ---------------- git 提交 ----------------

function git(args: string[]): { stdout: string; status: number } {
  // execFileSync 失败（退出码非 0）时抛异常，必须 try/catch 捕 status：
  // git diff --cached --quiet 退出码 1（有暂存改动）会抛异常，退出码 0（无改动）返回空串。
  try {
    const stdout = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: (e as { stdout?: string }).stdout ?? "", status: (e as { status?: number }).status ?? 1 };
  }
}

function gitCommitIfChanged(taskLine: string): boolean {
  if (!existsSync(".git")) return false;
  git(["add", "-A"]);
  const { status } = git(["diff", "--cached", "--quiet"]);  // 0=无暂存；非0=有暂存
  if (status === 0) return false;
  const tagMatch = taskLine.match(/\[([A-Z]+-[0-9]+)\]/);
  const desc = taskLine.replace(/^- \[[ x~]\] /, "").replace(/\[[A-Z]*-[0-9]*\]\s*/g, "").slice(0, 200);
  const msg = tagMatch ? `feat(${tagMatch[1]}): ${desc}` : `feat: ${desc}`;
  git(["commit", "-m", msg, "-m", "Co-Authored-By: Claude <noreply@anthropic.com>", "--no-verify", "--quiet"]);
  return true;
}

// ---------------- 核心：单任务一轮 query（保留不变）----------------

interface RoundOutcome {
  result: SDKResultMessage | null;
  wroteFiles: string[];    // PostToolUse hook 捕获的文件写入
  toolCalls: number;       // 总工具调用数
  aborted: boolean;
  postTokens: number | null;  // 压缩后总 token（/compact deep 探针用，普通轮=null）
  maxTokens: number | null;   // 模型上下文窗口（runOneTask 首个 tool 间隙 getContextUsage 捕获）
}

// 上下文探针：ctx 偏重时先发 /compact deep 试压一轮，看能不能把会话压下来。
// /compact 是本地 slash 命令，headless 下作为 prompt 发出即触发压缩（GLM 代理实测可用）。
// 压缩后大小取 compact_boundary.compact_metadata.post_tokens（权威信号）—— 不能取 result.usage.input_tokens：
// /compact 这一轮无 assistant 输出，实测 result.usage.input_tokens=0，会误判压缩后大小为 0。
// 出 compact_boundary 且有 post_tokens → 返回压缩后大小供 caller 比阈值（保留会话）；
// 没出 compact_boundary（/compact 未被识别）或没 post_tokens → 返回 null，caller fallback 弃会话。
async function probeCompactDeep(sessionId: string | null): Promise<number | null> {
  if (!sessionId) return null;   // 没会话历史，没东西可压
  let postTokens: number | null = null;
  try {
    const q = query({
      prompt: "/compact deep",
      options: {
        resume: sessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        disallowedTools: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"],
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      // compact_metadata.post_tokens = 压缩后真实 token 数（trigger=manual/auto）
      if (msg.type === "system" && (msg as { subtype?: string }).subtype === "compact_boundary") {
        const post = (msg as { compact_metadata?: { post_tokens?: number } }).compact_metadata?.post_tokens;
        if (typeof post === "number") postTokens = post;
      }
    }
  } catch (e) {
    log(`⚠️ /compact deep 探针异常（忽略，fallback 弃会话）: ${(e as Error).message}`);
    return null;
  }
  return postTokens;
}

// 铁律 prompt：禁提问 + 自主决策 + 已完成检测（防假完成）
function buildPrompt(taskLine: string): string {
  return `## 角色
你是无人值守开发助手，当前处于 24 小时自动运行模式。全程没有任何人在场，你必须独立完成决策。

## 铁律（违反会导致系统崩溃）
1. 绝对不要向用户提问任何问题，不要等待确认。
2. 执行任务过程中遇到任何选择或决策点，自己直接做决定，选最优解，不要询问用户。
3. 如果进入计划模式，直接执行计划，不要等待批准。
4. 如果检测到危险操作，低风险直接执行，高风险跳过并在 progress.md 说明原因。
5. 基于最佳实践自行推断，绝不索要额外信息。宁可基于合理假设推进，也不要停下来等。
6. 遇到报错或失败，自己排查、自己修，不要向用户求助。

## 已完成检测（防假完成）
「该任务对应的代码可能已存在」≠「已实现完整」。必须区分：
- ✅ 实现完整：目标函数有真实业务逻辑（非 pass / 非 NotImplementedError 占位 / 非 docstring+pass）。
- ❌ 不算完成：只有骨架/占位/签名+pass/TODO-docstring。
判定完整前必须用 Read 打开函数体看是不是真实逻辑，不是看函数名是否存在。
若只有骨架/占位 → 必须补完真实实现，不能空退（空退会被判空转标阻塞）。

## 本轮任务（只做这一个）
任务：${taskLine}

## 流程
1. 【必做第一步·已完成检测】Read/Grep 检查目标文件是否已存在且实现完整。完整→直接结束本轮。不完整→继续。
2. 读 .task.md 确认第一个未完成任务与上面一致。
3. 读 .claude/memory/ 了解项目背景。
4. 执行任务（代码写到文件）。遇到决策点自己拍板。
5. 更新 .claude/memory/progress.md。

## 上下文预算（防撑爆，尤其代理模型上下文有限）
- 只读与当前任务直接相关的文件，不要扫全项目、不要批量 Read 源码树。
- 复用 .claude/memory/ 里已有的项目背景，不要重新探索。
- 大文件用 Grep 定位再按行 Read，别整文件打开。
- 优先 grep/ls 验证再决定读不读，避免把无关文件灌进上下文。

## 规则
- 一次只做一个任务。不要自己改 .task.md 勾选状态——打勾由外部脚本负责。
- 本轮结束直接结束，不要输出总结。`;
}

async function runOneTask(taskLine: string, sessionId: string | null): Promise<RoundOutcome> {
  const ac = new AbortController();
  const wroteFiles: string[] = [];
  let toolCalls = 0;
  let lastHeartbeat = Date.now();

  // 看门狗计时器：单任务超过 ABORT_TIMEOUT_MIN 分钟无 PostToolUse 进展 → abort
  let watchdog: NodeJS.Timeout | null = null;
  const startWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (Date.now() - lastHeartbeat > ABORT_TIMEOUT_MIN * 60_000) {
        log(`⏱️ 单任务 ${ABORT_TIMEOUT_MIN}m 无进展，abort 重试`);
        ac.abort();
      }
    }, (ABORT_TIMEOUT_MIN + 5) * 60_000);
  };
  startWatchdog();

  const options: Parameters<typeof query>[0]["options"] = {
    abortController: ac,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: hasLimit(MAX_TURNS_PER_TASK) ? MAX_TURNS_PER_TASK : undefined,
    disallowedTools: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"],
    hooks: {
      // PostToolUse 实时捕获真实改动 —— 取代 git diff 猜测
      PostToolUse: [{
        hooks: [async (input) => {
          lastHeartbeat = Date.now();     // 任何工具调用都刷新心跳
          startWatchdog();
          toolCalls++;
          if (input.hook_event_name !== "PostToolUse") return {};
          const ti = input.tool_input as Record<string, unknown> | undefined;
          const path = ti?.file_path ?? ti?.path ?? ti?.notebook_path;
          if (typeof path === "string" && /Write|Edit|MultiEdit|NotebookEdit/.test(input.tool_name)) {
            wroteFiles.push(`${input.tool_name}:${path}`);
          }
          return {};
        }],
      }],
      // Stop 只用来刷新心跳（单轮靠 for-await result 决定停，不 block）
      Stop: [{
        hooks: [async () => { lastHeartbeat = Date.now(); return {}; }],
      }],
    },
  };

  if (sessionId) {
    options.resume = sessionId;   // 续接同一会话（永不用 continue）
  }

  const q = query({ prompt: buildPrompt(taskLine), options });

  let resultMsg: SDKResultMessage | null = null;
  let aborted = false;
  let capturedMaxTokens: number | null = null;
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "result") {
        resultMsg = msg as SDKResultMessage;
      }
      // 首个 tool 间隙抓一次模型上下文窗口（getContextUsage 只在 query 活跃时可调，这里是唯一窗口）。
      // 拿到就存，失败静默（健康度判定会跳过，不误伤）。
      if (capturedMaxTokens === null && msg.type === "assistant") {
        try {
          const usage = await q.getContextUsage();
          if (typeof usage?.maxTokens === "number" && usage.maxTokens > 0) {
            capturedMaxTokens = usage.maxTokens;
          }
        } catch {
          // 代理模型可能不支持，忽略
        }
      }
    }
  } catch (e) {
    if (ac.signal.aborted) aborted = true;
    else log(`⚠️ query 异常: ${(e as Error).message}`);
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }

  return { result: resultMsg, wroteFiles, toolCalls, aborted, postTokens: null, maxTokens: capturedMaxTokens };
}

// ---------------- state.json + events.jsonl 持久化 ----------------

interface StateJson {
  version: number;
  goal: string;
  loop_count: number;
  stall_task: string | null;       // taskLine.slice(0,120)，null=无空转
  stall_count: number;              // stall_task 连续空转次数，满 STALL_LIMIT 标阻塞
  had_any_commit: boolean;          // 防假完成守卫
  session_retries: number;          // 陷阱7：当前任务连续 session_dropped 次数，满3标阻塞
  status: string;
  last_tick_at: string | null;
  last_tick_id: string | null;
  last_termination: { reason: "done"; ts: string } | null; // 陷阱4：防完成后续 cron 刷 done
  last_input_tokens: number | null;  // 上轮上下文占用（result.usage.input_tokens），供下轮健康度判定
  ctx_max_tokens: number | null;     // 模型上下文窗口（getContextUsage 捕获一次，稳定）
}

const DEFAULT_STATE: StateJson = {
  version: 1,
  goal: "",
  loop_count: 0,
  stall_task: null,
  stall_count: 0,
  had_any_commit: false,
  session_retries: 0,
  status: "idle",
  last_tick_at: null,
  last_tick_id: null,
  last_termination: null,
  last_input_tokens: null,
  ctx_max_tokens: null,
};

// 陷阱1: 原子写 state.json（write-file-atomic：data fsync + dir fsync，崩溃后元数据不丢，进度数据不可丢）
function writeStateJsonAtomic(s: StateJson) {
  writeAtomic(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

function readStateJson(): StateJson {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    const obj = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    // 防御：补齐可能缺失的字段（向前兼容）
    return { ...DEFAULT_STATE, ...obj };
  } catch {
    log(`⚠️ state.json 解析失败，回退默认值`);
    return { ...DEFAULT_STATE };
  }
}

// ---- session_id 单源（.session_id 文件）----

function readSessionId(): string | null {
  if (!existsSync(SESSION_FILE)) return null;
  const s = readFileSync(SESSION_FILE, "utf8").trim();
  return s || null;
}

function writeSessionId(id: string) {
  writeFileSync(SESSION_FILE, id);
}

function clearSessionId() {
  rmSync(SESSION_FILE, { force: true });
}

// ---- events.jsonl 审计流 ----

interface EventEnvelope {
  ts: string;
  type: string;
  tick_id: string | null;
  loop_count: number | null;
  data: Record<string, unknown>;
}

// appendFileSync 单行 < PIPE_BUF 原子（Linux PIPE_BUF=4096，我们一行远小于）。
function appendEvent(type: string, data: Record<string, unknown>, ctx?: { tick_id?: string | null; loop_count?: number | null }) {
  const env: EventEnvelope = {
    ts: now(),
    type,
    tick_id: ctx?.tick_id ?? null,
    loop_count: ctx?.loop_count ?? null,
    data,
  };
  appendFileSync(EVENTS_FILE, JSON.stringify(env) + "\n");
}

// 读 events.jsonl 末尾 N 条（解析失败的行跳过）
function readEventsTail(n: number): EventEnvelope[] {
  if (!existsSync(EVENTS_FILE)) return [];
  const lines = readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  const tail = lines.slice(-n);
  const out: EventEnvelope[] = [];
  for (const l of tail) {
    try { out.push(JSON.parse(l) as EventEnvelope); } catch { /* 跳过损坏行 */ }
  }
  return out;
}

// 统计 events.jsonl 中某类型事件数
function countEvents(type: string): number {
  if (!existsSync(EVENTS_FILE)) return 0;
  const lines = readFileSync(EVENTS_FILE, "utf8").split("\n").filter(Boolean);
  let c = 0;
  for (const l of lines) {
    try { if (JSON.parse(l).type === type) c++; } catch { /* skip */ }
  }
  return c;
}

// 生成 tick_id（时间戳 + 短随机，用于 tick_started/tick_completed 配对做崩溃检测）
// 本地时间，跟 now() 对齐（同样跟随系统时区 / TZ）。
function genTickId(): string {
  const t = localParts();
  const ts = `${t.y}${t.mo}${t.da}${t.h}${t.mi}${t.s}`;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rnd}`;
}

// ---- flock：进程级并发保护（陷阱2，用 proper-lockfile）----

let heldRelease: (() => void) | null = null;

// 陷阱2: flock 进程级并发保护。
// proper-lockfile 处理 stale lock（mtime 过期自动 takeover）、fsync 全套，24h 无人值守场景必用库。
// 非阻塞语义：retries:0，拿不到锁抛 ELOCKED → 返回 already_running，不等待。
// realpath:false —— 锁目标文件（.tick.lock）可能不存在，无需 canonicalize。
function tryAcquireLock(): boolean {
  try {
    // lockSync 返回 release 函数；retries:0 = 非阻塞；stale:60s = 进程 kill -9 后 60s 可被抢
    const release = lockfile.lockSync(LOCK_FILE, {
      stale: LOCK_STALE_MS,
      retries: 0,
      realpath: false,
    });
    heldRelease = release;
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ELOCKED") return false; // 锁被占，非阻塞返回
    // 其它错误（如权限）记日志后视为拿不到
    log(`⚠️ lockfile.lockSync 异常: ${code ?? (e as Error).message}`);
    return false;
  }
}

function releaseLock() {
  if (heldRelease) {
    try { heldRelease(); } catch { /* 锁可能已被 stale takeover，释放失败忽略 */ }
    heldRelease = null;
  }
  // 兜底：proper-lockfile release 会删 .lock 文件，但若已 stale 则可能残留
  try { rmSync(LOCK_FILE + ".lock", { force: true }); } catch { /* 已删 */ }
}

// ---------------- tick()：无状态单步 ----------------

type TickOutcome =
  | { kind: "advanced" }
  | { kind: "stalled" }
  | { kind: "blocked" }
  | { kind: "session_dropped" }
  | { kind: "terminated" }
  | { kind: "stopped" }
  | { kind: "already_terminated" }
  | { kind: "already_running" };

// 16 步幂等单步：取第一个未完成任务 → runOneTask（核心不变）→ 判定 → 打勾/标阻塞 → commit → 落盘 → exit
async function tick(): Promise<TickOutcome> {
  // 步骤0: flock（陷阱2，proper-lockfile）
  if (!tryAcquireLock()) {
    appendEvent("tick_locked", { reason: "another tick holds lock" });
    return { kind: "already_running" };
  }

  // 锁会在 finally 释放
  let tickId: string | null = null;
  try {
    // 步骤1: 读 state.json（不存在用默认值）
    const state = readStateJson();

    // 步骤2: .stop 哨兵检查（陷阱3）—— 让 --watch 在下次 tick 退出
    if (existsSync(STOP_FILE)) {
      appendEvent("tick_skipped", { reason: "stop sentinel present" });
      log("⏭️ .stop 哨兵存在，跳过本次 tick");
      return { kind: "stopped" };
    }

    // 步骤3: last_termination 检查（陷阱4）—— 防 cron 完成后空转刷屏
    if (state.last_termination) {
      appendEvent("tick_skipped", { reason: "already_terminated", last_termination: state.last_termination });
      return { kind: "already_terminated" };
    }

    // 步骤4: 读 .task.md，取 currentTaskLine，genTickId
    const { total, remaining } = readTasks();
    const taskLine = currentTaskLine();
    tickId = genTickId();

    // 步骤5: append tick_started（与 tick_completed 配对做崩溃检测）
    appendEvent("tick_started", { remaining, total, current_task: taskLine ?? null }, { tick_id: tickId, loop_count: state.loop_count + 1 });

    // 步骤6: 终止判定 A: remaining=0
    if (remaining === 0) {
      const blocked = countBlocked();
      // 防假完成守卫：有阻塞标记或全程零 commit → suspected_false_completion（不设 last_termination，待人工介入）
      if (blocked > 0 || !state.had_any_commit) {
        log(`⚠️ remaining=0 但 ${blocked > 0 ? `${blocked} 个 [~] 阻塞` : "全程零 commit"}：疑假完成，挂起待人工核实（不设 last_termination）`);
        appendEvent("suspected_false_completion", { blocked, had_any_commit: state.had_any_commit, total }, { tick_id: tickId, loop_count: state.loop_count });
        state.status = "blocked_suspect";
        state.last_tick_at = now();
        state.last_tick_id = tickId;
        writeStateJsonAtomic(state);
        appendEvent("tick_completed", { outcome: "terminated" }, { tick_id: tickId, loop_count: state.loop_count });
        return { kind: "terminated" };
      }
      log(`✅ 全部完成！共 ${total} 个任务`);
      appendEvent("done", { total }, { tick_id: tickId, loop_count: state.loop_count });
      state.last_termination = { reason: "done", ts: now() };
      state.status = "completed";
      state.last_tick_at = now();
      state.last_tick_id = tickId;
      writeStateJsonAtomic(state);
      appendEvent("tick_completed", { outcome: "terminated" }, { tick_id: tickId, loop_count: state.loop_count });
      return { kind: "terminated" };
    }

    if (!taskLine) {
      // remaining>0 但没有未完成任务行（数据不一致）—— 不推进，等人工修
      log("⚠️ remaining>0 但找不到未完成任务行，.task.md 数据不一致");
      appendEvent("tick_skipped", { reason: "task_line_missing_with_remaining", remaining }, { tick_id: tickId, loop_count: state.loop_count });
      return { kind: "stalled" };
    }

    // 步骤8: 陷阱5 stallTask 跨 tick reset + 陷阱7b 计数器跨任务 reset
    // （.task.md 可能被人工改后 stallTask 失效，currentTaskKey 变了就 reset）
    // 同理：任务推进了（与上次空转的不是同一任务）→ session_retries/stall_count 也归零，
    // 不带病继承到下一任务（修「每任务头一轮就被判死」的卡死 bug）。
    const taskKey = taskLine.slice(0, 120);
    if (state.stall_task !== taskKey) {
      if (state.stall_task !== null) {
        log(`↪️ 任务已推进，计数器归零（stall_count/session_retries reset）`);
      }
      state.stall_task = null;
      state.stall_count = 0;
      state.session_retries = 0;
    }

    // 步骤9: loop_count++，status=running，pre-run 写盘（让 --status 看到正在跑）
    state.loop_count++;
    state.status = "running";
    state.last_tick_at = now();
    state.last_tick_id = tickId;
    writeStateJsonAtomic(state);
    log("━".repeat(60));
    log(`🔄 第 ${state.loop_count} 轮 | 剩余 ${remaining}/${total} | tick_id=${tickId}`);
    log(`📋 ${taskLine}`);

    // 步骤10: 读 .session_id，session_resumed 事件
    let sessionId = readSessionId();
    // 上下文健康度：上轮 input_tokens 占比超 CTX_RECYCLE_RATIO → 先试 /compact deep 探针压一轮，
    // 压不下来（仍超阈值）才弃会话开新会话。防同一 session 跨 tick 累积撞墙。
    if (sessionId && state.last_input_tokens !== null && CTX_RECYCLE_RATIO > 0) {
      const max = state.ctx_max_tokens ?? 0;
      if (max > 0 && state.last_input_tokens >= Math.floor(max * CTX_RECYCLE_RATIO)) {
        log(`🧹 上下文偏重（${state.last_input_tokens}/${max} ≈ ${(state.last_input_tokens / max * 100).toFixed(0)}% ≥ ${CTX_RECYCLE_RATIO}），试 /compact deep 探针压一轮`);
        const afterTokens = await probeCompactDeep(sessionId);
        if (afterTokens !== null && max > 0 && afterTokens < Math.floor(max * CTX_RECYCLE_RATIO)) {
          log(`✅ /compact deep 压成功：${state.last_input_tokens} → ${afterTokens}，保留会话继续 resume`);
          appendEvent("compact_probe_ok", { before: state.last_input_tokens, after: afterTokens, ratio: CTX_RECYCLE_RATIO }, { tick_id: tickId, loop_count: state.loop_count });
          state.last_input_tokens = afterTokens;
        } else {
          // 探针没压下来（/compact 未被识别或压完仍超阈值）→ 直接弃旧会话开新会话
          log(`⚠️ /compact deep 未压到阈值（${afterTokens ?? "?"}/${max}），弃旧会话下轮开新会话`);
          appendEvent("compact_probe_failed", { before: state.last_input_tokens, after: afterTokens, ratio: CTX_RECYCLE_RATIO }, { tick_id: tickId, loop_count: state.loop_count });
          clearSessionId();
          sessionId = null;
          state.last_input_tokens = null;  // 新会话从零开始，旧 token 数作废
        }
      }
    }
    if (sessionId) {
      appendEvent("session_resumed", { session_id: sessionId }, { tick_id: tickId, loop_count: state.loop_count });
    }

    // 步骤11: runOneTask（核心不变：query + PostToolUse hook + 看门狗）
    const { result, wroteFiles, toolCalls, aborted, maxTokens } = await runOneTask(taskLine, sessionId);

    // 捕获模型上下文窗口（首轮拿到就缓存进 state，后续复用；拿不到留 null，健康度判定自动跳过）
    if (state.ctx_max_tokens === null && typeof maxTokens === "number" && maxTokens > 0) {
      state.ctx_max_tokens = maxTokens;
      log(`📏 模型上下文窗口 = ${maxTokens} tokens（已缓存，供 ctx 健康度判定）`);
    }

    // 步骤12: session_id 更新（新会话 → session_created）
    if (result?.session_id && result.session_id !== sessionId) {
      sessionId = result.session_id;
      writeSessionId(sessionId);
      if (state.loop_count === 1) {
        log(`🔗 新会话已建立: ${sessionId}`);
      }
      appendEvent("session_created", { session_id: sessionId }, { tick_id: tickId, loop_count: state.loop_count });
    }

    if (result) {
      if (result.subtype !== "success") {
        log(`⚠️ 本轮非 success: subtype=${result.subtype} stop_reason=${result.stop_reason}`);
      }
      // 记录上轮上下文占用，供下轮健康度判定（input_tokens = 本轮实际喂进模型的 token）。
      const inTok = result.usage?.input_tokens;
      if (typeof inTok === "number") state.last_input_tokens = inTok;
    }

    // 陷阱6 ctx-overflow 改结构化判定（subtype + errors/stop_reason，不再 stringify+正则）
    const isCtxOverflow =
      result?.subtype === "error_during_execution" &&
      (result.errors?.some((e) => /context|exceed|too long/i.test(e))
        || /context/i.test(result.stop_reason ?? ""));

    if (aborted || isCtxOverflow) {
      // 陷阱7: session_retries 防 ctx-overflow 死循环（连续 N 次弃会话标阻塞）
      state.session_retries++;
      const reason = aborted ? "aborted" : "ctx_overflow";
      log(`🧠 撞上下文撑爆/超时（${reason}），弃会话下轮开新会话重试同任务（session_retries=${state.session_retries}/${SESSION_RETRY_LIMIT}）`);
      clearSessionId();
      appendEvent("session_dropped", { reason, session_retries: state.session_retries, limit: SESSION_RETRY_LIMIT }, { tick_id: tickId, loop_count: state.loop_count });
      if (aborted) appendEvent("aborted", { task: taskKey }, { tick_id: tickId, loop_count: state.loop_count });
      // 不打勾，不标阻塞（除非连续 N 次）
      if (state.session_retries >= SESSION_RETRY_LIMIT) {
        log(`🚧 连续 ${SESSION_RETRY_LIMIT} 次 session_dropped，标 [~] 阻塞跳过，推进下一任务`);
        blockFirst();
        appendEvent("task_blocked", { task: taskKey, reason: "session_retry_limit" }, { tick_id: tickId, loop_count: state.loop_count });
        state.session_retries = 0;
        state.stall_task = null;
        state.stall_count = 0;
      }
      state.status = "ctx_overflow_retry";
      appendEvent("tick_completed", { outcome: "session_dropped" }, { tick_id: tickId, loop_count: state.loop_count });
      return { kind: "session_dropped" };
    }

    // 步骤15: didRealWork 判定（看 PostToolUse hook 捕获的真实写入，不是 git diff 猜测）
    const didRealWork = wroteFiles.length > 0;
    if (didRealWork) {
      tickFirst();
      const committed = gitCommitIfChanged(taskLine);
      if (committed) state.had_any_commit = true;
      log(`⏱️ 第 ${state.loop_count} 轮结束：写入 ${wroteFiles.length} 文件 / ${toolCalls} 工具调用（${committed ? "已提交" : "无暂存"}）`);
      state.stall_task = null;
      state.stall_count = 0;
      state.session_retries = 0;
      appendEvent("task_completed", { task: taskKey, wrote_files: wroteFiles, committed }, { tick_id: tickId, loop_count: state.loop_count });
    } else {
      // 零改动：worker 判了"已完成"但没写代码 → 记空转，不打勾
      state.stall_task = taskKey;
      state.stall_count++;
      log(`⏸️ 零改动空转 #${state.stall_count}: ${taskKey}`);
      appendEvent("task_stall", { task: taskKey, stall_count: state.stall_count, limit: STALL_LIMIT }, { tick_id: tickId, loop_count: state.loop_count });
      if (state.stall_count >= STALL_LIMIT) {
        blockFirst();
        log(`🚧 连续 ${STALL_LIMIT} 次空转，标 [~] 阻塞跳过，推进下一任务`);
        appendEvent("task_blocked", { task: taskKey, reason: "stall_limit" }, { tick_id: tickId, loop_count: state.loop_count });
        state.stall_task = null;
        state.stall_count = 0;
      }
    }

    // 步骤16: 写 state.json + tick_completed
    state.status = "idle";
    state.last_tick_at = now();
    writeStateJsonAtomic(state);
    const outcome: TickOutcome["kind"] = didRealWork ? "advanced" : (state.stall_count > 0 ? "stalled" : "blocked");
    appendEvent("tick_completed", { outcome }, { tick_id: tickId, loop_count: state.loop_count });
    return didRealWork ? { kind: "advanced" } : (state.stall_count > 0 ? { kind: "stalled" } : { kind: "blocked" });
  } finally {
    // 步骤16 续: 释放 flock（finally 保证异常/崩溃也释放）
    releaseLock();
  }
}

// ---------------- watch()：自驱循环 ----------------

// 自驱场景：bootstrap + while(tick())，保留长进程语义给命令行直跑。
// 终止类 outcome（done/already_terminated/stopped）break；
// already_running 退避 30s；其余退避 5s。
async function watch(goal: string) {
  writeFileSync(PID_FILE, String(process.pid));
  try {
    log(`orchestrator --watch 启动，PID=${process.pid}`);

    if (!existsSync(TASK_FILE)) {
      await bootstrapTasks(goal);
    }
    // 记录 goal 到 state.json（如果 state 为空/首次）
    if (!existsSync(STATE_FILE)) {
      writeStateJsonAtomic({ ...DEFAULT_STATE, goal });
    } else {
      const s = readStateJson();
      if (!s.goal) { s.goal = goal; writeStateJsonAtomic(s); }
    }
    appendEvent("bootstrap_completed", { goal }, { tick_id: null, loop_count: 0 });

    while (true) {
      const o = await tick();
      if (["done", "already_terminated", "stopped"].includes(o.kind)) break;
      if (o.kind === "already_running") {
        await sleep(ALREADY_RUNNING_SLEEP_MS);
        continue;
      }
      // advanced / stalled / blocked / session_dropped
      await sleep(WATCH_SLEEP_MS);
    }
    log("orchestrator --watch 退出");
  } finally {
    rmSync(PID_FILE, { force: true });
  }
}

// ---------------- bootstrap：知识优先，按需探索 ----------------
// 旧设计让 LLM 自己 agentic 探索项目拿上下文 → 要么探索过度爆上下文（Claude Code 拆得准但爆）、
// 要么没上下文纯靠 goal 猜（Hermes 拆得不准）。根因是「谁拿项目上下文」绑在了 LLM 身上。
// 改法：把最高价值的现成知识（CLAUDE.md + memory）由 orchestrator 代码直接读出来喂进 prompt，
// 模型拿这些做基线，剩下不够的按需自己探索——不限制死，只把它从「无脑全扫」掰向「已知为基、按需补」。
// 复用 claude code 已沉淀的知识，旧工程不重扫；新工程走退路给个目录概览当起点。

// 退路：新工程/没用过 claude code 时，代码读一个轻量项目结构概览当探索起点（不是真相、只是地图）。
// 限深 3 层、跳依赖/构建产物大目录（node_modules 等）、保留隐藏文件（.claude 等可能有价值）+ manifest。
function surveyProjectTree(): string {
  const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor", "__pycache__", ".venv", "out"]);
  const lines: string[] = [];
  const walk = (dir: string, depth: number, prefix: string) => {
    if (depth > 3) return;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;            // 只跳依赖/构建产物等大目录；隐藏文件（.claude 等）保留——可能有价值
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      lines.push(`${e.isDirectory() ? "📁" : "📄"} ${rel}`);
      if (e.isDirectory() && depth < 3) walk(`${dir}/${e.name}`, depth + 1, rel);
    }
  };
  walk(".", 1, "");
  const manifests = ["package.json", "go.mod", "requirements.txt", "Cargo.toml", "pyproject.toml", "pom.xml"];
  const mf: string[] = [];
  for (const m of manifests) {
    if (!existsSync(m)) continue;
    try {
      const c = readFileSync(m, "utf8");
      mf.push(`### ${m}\n${c.length > 1500 ? c.slice(0, 1500) + "\n...(截断)" : c}`);
    } catch { /* skip */ }
  }
  return lines.slice(0, 300).join("\n") + (mf.length ? "\n\n" + mf.join("\n\n") : "");
}

// 读最高价值的现成知识喂给 bootstrap。CLAUDE.md → memory 累积记忆（这是「已知」，直接给）。
// 给完基线后不锁死——剩余细节模型按需自己探索（prompt 说明），而不是无脑全扫。
function loadProjectKnowledge(): string {
  const parts: string[] = [];
  if (existsSync("CLAUDE.md")) {
    parts.push("## CLAUDE.md（项目说明书）\n" + readFileSync("CLAUDE.md", "utf8"));
  }
  if (existsSync(MEMO_DIR)) {
    // 累积记忆：架构/约定/模块边界等。跳过 progress.md（loop 自己写的增量流水账，对「怎么拆」没价值）。
    let memos: string[] = [];
    try { memos = readdirSync(MEMO_DIR).filter((f) => f.endsWith(".md") && f !== "progress.md").sort(); }
    catch { memos = []; }
    for (const f of memos) {
      try { parts.push(`## .claude/memory/${f}\n` + readFileSync(`${MEMO_DIR}/${f}`, "utf8")); }
      catch { /* skip */ }
    }
  }
  if (parts.length === 0) {
    // 真新工程/没用过 claude code → 退路：代码轻量勘察当探索起点
    parts.push("## 项目结构（自动勘察）\n" + surveyProjectTree());
  }
  let text = parts.join("\n\n");
  if (text.length > 20_000) text = text.slice(0, 20_000) + "\n...(已截断，详见项目文件)";  // 截断防爆
  return text;
}

async function bootstrapTasks(goal: string) {
  log("首次运行，拆解任务...");
  log(`目标：${goal}`);
  const knowledge = loadProjectKnowledge();
  log(`📚 已加载项目知识 ${knowledge.length} 字符（CLAUDE.md/memory 基线 + 按需探索）`);
  const q = query({
    // 高价值现成知识由代码喂进来当基线；CLAUDE.md/memory 之外、拆任务还需要细节时，模型按需自己探索，
    // 不要无脑全扫（那是爆上下文的根因）。已知为基、按需补，而非限制死。
    prompt: `根据用户目标拆解为最小可执行任务列表。下方【项目背景】是已为你准备的最高价值知识（CLAUDE.md / 记忆 / 勘察），先吃透它做基线；拆任务还需的细节按需自己探索，但只读相关的、别无脑全扫。

${knowledge}

用户目标：${goal}
要求：
- 每个任务足够小（一个函数、一个文件、一个接口），一个会话内能独立完成
- 按依赖顺序排列
- 输出格式只有任务列表，每行一个：
- [ ] 任务描述
- [ ] 任务描述
...`,
    options: {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: hasLimit(BOOTSTRAP_MAX_TURNS) ? BOOTSTRAP_MAX_TURNS : undefined,
      // 不禁文件工具：CLAUDE.md/memory 当基线喂进来了，剩下按需探索。无脑全扫才爆上下文，按需探索不会。
      disallowedTools: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"],
    },
  });
  let text = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      const r = msg as SDKResultMessage;
      text = r.subtype === "success" ? (r.result ?? "") : (r.errors ?? []).join("\n");
    } else if (msg.type === "assistant") {
      const content = (msg as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
            text += (b as { text?: string }).text ?? "";
          }
        }
      }
    }
  }
  const taskLines = text.split("\n").filter((l) => /^- \[ \]/.test(l));
  writeFileSync(TASK_FILE, taskLines.join("\n") + "\n");
  if (taskLines.length === 0) {
    log("❌ 任务拆解失败");
    process.exit(1);
  }
  log(`✅ 共 ${taskLines.length} 个任务`);
}

// ---------------- 状态 / 报告（改读 state.json + events.jsonl）----------------

// 读 .pid 探活：看 --watch 是否在跑
function watchRunning(): { running: boolean; pid: number | null } {
  if (!existsSync(PID_FILE)) return { running: false, pid: null };
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  if (isNaN(pid)) return { running: false, pid: null };
  try { process.kill(pid, 0); return { running: true, pid }; }
  catch { return { running: false, pid }; }
}

function showStatus() {
  // 优先读 state.json
  const s = readStateJson();
  const { total, remaining, done, blocked } = readTasks();
  console.log("━".repeat(60));
  console.log("📊 orchestrator 状态");
  console.log("━".repeat(60));
  console.log(`status: ${s.status}`);
  console.log(`goal: ${s.goal || "(未设置)"}`);
  console.log(`任务: 总 ${total} | 完成 ${done} | 阻塞 ${blocked} | 待办 ${remaining}`);
  console.log(`loop_count: ${s.loop_count}`);
  if (s.ctx_max_tokens !== null && s.last_input_tokens !== null) {
    const pct = (s.last_input_tokens / s.ctx_max_tokens * 100).toFixed(0);
    console.log(`上下文: ${s.last_input_tokens}/${s.ctx_max_tokens} tokens（${pct}%，超 ${CTX_RECYCLE_RATIO} 触发 /compact deep 探针）`);
  }
  console.log(`had_any_commit: ${s.had_any_commit}`);
  console.log(`stall_task: ${s.stall_task ?? "(无)"}`);
  console.log(`stall_count: ${s.stall_count} / ${STALL_LIMIT}`);
  console.log(`session_retries: ${s.session_retries} / ${SESSION_RETRY_LIMIT}`);
  console.log(`last_tick_at: ${s.last_tick_at ?? "(无)"}`);
  console.log(`last_tick_id: ${s.last_tick_id ?? "(无)"}`);
  console.log(`last_termination: ${s.last_termination ? `${s.last_termination.reason} @ ${s.last_termination.ts}` : "(无)"}`);
  const wr = watchRunning();
  console.log(`\n--watch 进程: ${wr.running ? `运行中 PID=${wr.pid}` : "未运行"}`);
  const sid = readSessionId();
  console.log(`session_id: ${sid ?? "(无，下轮开新会话)"}`);

  console.log("\n--- events.jsonl 末尾 8 条 ---");
  const evs = readEventsTail(8);
  if (evs.length === 0) {
    console.log("(无事件)");
  } else {
    for (const e of evs) {
      const lc = e.loop_count !== null ? `#${e.loop_count}` : "";
      const tid = e.tick_id ? `[${e.tick_id}]` : "";
      console.log(`[${e.ts}] ${e.type} ${lc}${tid} ${JSON.stringify(e.data)}`);
    }
  }
}

function showReport() {
  console.log("━".repeat(60));
  console.log("📊 无人值守运行报告");
  console.log("━".repeat(60));
  const s = readStateJson();
  const { total, remaining, done, blocked } = readTasks();
  console.log(`任务进度: 完成 ${done} / 总 ${total}（阻塞 ${blocked} · 待办 ${remaining}）`);
  console.log(`loop_count: ${s.loop_count}`);
  console.log(`status: ${s.status}`);
  if (s.last_termination) console.log(`终止: ${s.last_termination.reason} @ ${s.last_termination.ts}`);

  // 从 events.jsonl 统计
  console.log("\n--- 事件统计（events.jsonl）---");
  console.log(`  task_completed: ${countEvents("task_completed")}`);
  console.log(`  task_blocked: ${countEvents("task_blocked")}`);
  console.log(`  task_stall: ${countEvents("task_stall")}`);
  console.log(`  session_dropped: ${countEvents("session_dropped")}`);
  console.log(`  aborted: ${countEvents("aborted")}`);

  const wr = watchRunning();
  console.log(`\n--watch 进程: ${wr.running ? `运行中 PID=${wr.pid}` : "未运行"}`);

  // night_run.log 兜底 grep（保留历史异常排查能力）
  if (existsSync(LOG_FILE)) {
    const logText = readFileSync(LOG_FILE, "utf8");
    console.log("\n--- night_run.log 异常尾 20 条 ---");
    const errs = logText.split("\n").filter((l) => /错误|失败|❌|异常|假死|空转|阻塞|stale|crash|崩溃/.test(l)).slice(-20);
    console.log(errs.length ? errs.join("\n") : "（未发现）");
  }
}

// 陷阱3: --stop 改为写 .stop 哨兵 + 杀 --watch PID（如有且活着）
function stopAll() {
  log("收到 --stop 指令，写 .stop 哨兵");
  writeFileSync(STOP_FILE, `${now()} PID=${process.pid}\n`);
  // 杀 --watch PID（如果存在且活着）—— tick 是短进程，杀了 cron 5m 后又来，所以靠哨兵而非杀进程
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (!isNaN(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`已发送 SIGTERM 给 --watch 进程 PID=${pid}`);
      } catch {
        console.log(`--watch 进程 PID=${pid} 未运行（PID 文件残留）`);
      }
      rmSync(PID_FILE, { force: true });
    }
  } else {
    console.log("无 --watch 进程在跑（仅写 .stop 哨兵，阻止后续 tick）");
  }
  console.log("已写 .stop 哨兵。下次 tick 会跳过。用 --resume 清除哨兵恢复。");
}

// --resume：删 .stop 哨兵
function resumeRun() {
  if (existsSync(STOP_FILE)) {
    rmSync(STOP_FILE, { force: true });
    console.log("已删除 .stop 哨兵，恢复 tick/watch");
  } else {
    console.log("无 .stop 哨兵，无需恢复");
  }
}

// ---------------- 入口 ----------------

// 解析命令行（用 node:util parseArgs，零依赖 Node 18+）：
// --cwd <dir> 可放任意位置；--watch/--status/--report/--stop/--resume 控制 action；goal 为位置参数。
function parseArgs(argv: string[]): {
  goal?: string; cwd?: string;
  action?: "status" | "report" | "stop" | "resume" | "watch";
} {
  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] };
  try {
    // parseArgs 第二参数是 args；node:util 的 parseArgs(config?: T) 只接一个 config 对象，args 放 config.args
    parsed = nodeParseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        cwd: { type: "string" },
        watch: { type: "boolean", default: false },
        status: { type: "boolean", default: false },
        report: { type: "boolean", default: false },
        stop: { type: "boolean", default: false },
        resume: { type: "boolean", default: false },
      },
    });
  } catch (e) {
    console.error(`参数解析失败: ${(e as Error).message}`);
    process.exit(2);
  }
  const { values, positionals } = parsed;
  const cwd = typeof values.cwd === "string" ? values.cwd : undefined;
  const goal = positionals.length > 0 ? positionals[0] : undefined;
  // action 优先级：显式 flag（先到先得，互斥）
  let action: "status" | "report" | "stop" | "resume" | "watch" | undefined;
  if (values.watch) action = "watch";
  else if (values.status) action = "status";
  else if (values.report) action = "report";
  else if (values.stop) action = "stop";
  else if (values.resume) action = "resume";
  return { goal, cwd, action };
}

function preflightEnv() {
  const key = process.env.ANTHROPIC_API_KEY;
  const envFile = process.env.LOOP_ENV_FILE || `${homedir()}/.config/loop.env`;
  if (key && key.trim() !== "") return;
  if (existsSync(envFile)) return;
  console.error(
    `⚠️ 未检测到 ANTHROPIC_API_KEY（非交互进程不 source ~/.bashrc）。\n` +
    `  写进 ${envFile} 一行即可：\n` +
    `    ANTHROPIC_API_KEY=sk-...\n` +
    `    ANTHROPIC_BASE_URL=http://your-proxy:3000   # 走代理才填\n` +
    `  （key 已通过别的机制注入则忽略）`
  );
}

async function main() {
  const { goal, cwd, action } = parseArgs(process.argv.slice(2));

  // --cwd > LOOP_PROJECT env > 当前目录。chdir 后产物/git/会话目录三者统一。
  const targetCwd = cwd ? resolve(cwd) : (process.env.LOOP_PROJECT ? resolve(process.env.LOOP_PROJECT) : process.cwd());
  if (!existsSync(targetCwd) || !statSync(targetCwd).isDirectory()) {
    console.error(`目标目录不存在或非目录: ${targetCwd}`);
    process.exit(1);
  }
  process.chdir(targetCwd);

  mkdirSync(MEMO_DIR, { recursive: true });

  // 预检仅对起 query 的动作（--watch/裸跑）做；只读/操控动作不挡。
  if (action === "watch" || !action) preflightEnv();

  if (action === "status") { showStatus(); return; }
  if (action === "report") { showReport(); return; }
  if (action === "stop") { stopAll(); return; }
  if (action === "resume") { resumeRun(); return; }

  // --watch 或裸跑
  if (action === "watch" || !action) {
    if (!goal && !existsSync(TASK_FILE)) {
      console.error('首次运行需要指定目标，例如：\n  loop --cwd /path/to/project --watch "构建一个Go REST API"');
      process.exit(1);
    }
    const effectiveGoal = goal ?? (existsSync(STATE_FILE) ? readStateJson().goal : "");
    if (!effectiveGoal) {
      console.error('无法确定目标：无 goal 参数且 state.json 无 goal');
      process.exit(1);
    }
    await watch(effectiveGoal);
    return;
  }
}

main().catch((e) => {
  log(`💥 orchestrator 崩溃: ${e?.stack || e}`);
  rmSync(PID_FILE, { force: true });
  releaseLock();
  process.exit(1);
});
