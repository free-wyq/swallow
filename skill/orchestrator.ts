// orchestrator.ts —— SDK 版 24h 无人值守开发 orchestrator（tick 化 + 事件溯源）
//
// 用法：
//   npx tsx orchestrator.ts [--cwd <项目目录>] "目标"           # 裸跑=--watch（自驱：bootstrap+while(tick)）
//   npx tsx orchestrator.ts [--cwd <项目目录>] --watch "目标"    # 显式自驱
//   npx tsx orchestrator.ts [--cwd <项目目录>] --status         # 多行实时状态（给人看）
//   npx tsx orchestrator.ts [--cwd <项目目录>] --status --json   # 结构化 JSON（给程序读，跨平台零依赖）
//   npx tsx orchestrator.ts [--cwd <项目目录>] --report         # 运行报告
//   npx tsx orchestrator.ts [--cwd <项目目录>] --stop            # 写 .stop 哨兵 + 杀 --watch PID
//   npx tsx orchestrator.ts [--cwd <项目目录>] --resume         # 删 .stop 哨兵 + 若 watch 没在跑则拉起（恢复运行）
//
// --cwd 指定目标项目目录（产物写入处 + git commit 的仓库 + 会话工作目录）；不传则用当前目录
// 或 SWALLOW_PROJECT 环境变量。
//
// 会话策略：首轮新会话（query 返回的 session_id 落盘 .session_id），后续轮 resume 同一会话；
// 永不使用 continue（避免旧会话污染）。session_id 由 .session_id 文件单源管理（不进 state.json）。
//
// 设计原则：orchestrator 只管推进 + 把结果结构化落盘（state.json + events.jsonl）。
// 战报/推送由外部 agent 读这些结构化结果自行组织发送，orchestrator 不发战报。
// 推进靠 --watch 长进程（tick 内核 + state/events 落盘，崩溃可恢复），不依赖外部触发。

import { query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync, readdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs as nodeParseArgs } from "node:util";
import lockfile from "proper-lockfile";

// write-file-atomic v7 不自带类型且 @types 版本滞后。用 ambient 声明（单独 .d.ts 文件，
// TS 对「untyped module」不允许 inline declare module 增强，必须外置）。见 write-file-atomic.d.ts。
import writeFileAtomic from "write-file-atomic";
const writeAtomic = (path: string, data: string) => writeFileAtomic.sync(path, data);

// ---------------- 启动期：加载 swallow.env（调度器友好）----------------
// cron / systemd / hermes cron 这类非交互调度器跑的是干净 env，不会 source ~/.bashrc——
// 用户写在 ~/.bashrc 里的 ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 它们根本拿不到
// （实测：调度器里得手 export + sed 抠 ~/.bashrc 才跑得通，极脆、还常触发审批）。
// 放一份 KEY=VALUE 进 ~/.config/swallow/swallow.env，orchestrator 启动时读进 process.env；
// 已 export 的环境变量优先、不覆盖。SWALLOW_ENV_FILE 可指到别处。
function loadEnvFileOnce() {
  const path = process.env.SWALLOW_ENV_FILE || `${homedir()}/.config/swallow/swallow.env`;
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

// 限额写死在脚本（不读 swallow.env）：当前大背景 token 不限量（自托管/免费代理模型无按量计费），
// 预算/轮数护栏纯属挡路 → 一律 0=不限；行为护栏（空转/超时/重试）留正数防死循环。要改改下面的常量。
// 密钥/代理/模型才走 swallow.env（见 loadEnvFileOnce）。hasLimit(n)=n>0 让写死的值自洽：0=关、正数=开。
const UNLIMITED = 0;  // 0 表示不限；常量比较时用 hasLimit(n) = n > 0
const hasLimit = (n: number) => n > 0;

// ---------------- 配置 ----------------

const TASK_FILE = ".task.md";
const LOG_FILE = "night_run.log";
const SESSION_FILE = ".session_id";      // session_id 单源（不进 state.json）
const PID_FILE = ".pid";                // --watch 进程的 PID

// 持久化与锁文件
const STATE_FILE = "state.json";        // 机器读恢复点快照（原子写）
const EVENTS_FILE = "events.jsonl";     // append-only 审计流
const STOP_FILE = ".stop";              // .stop 哨兵：--stop 写，--watch 下次 tick 检测到则退出
const LOCK_FILE = ".tick.lock";          // flock 进程级并发保护（防多 watch / 手动与 watch 并发）

// 限额写死（不读环境变量）：token 不限量场景下，轮数护栏纯属挡路 → 一律 0=不限。
// 行为护栏留正数防死循环（空转/超时/重试）。要改改这里的常量，不必改 swallow.env。
const MAX_TURNS_PER_TASK = UNLIMITED;        // 单任务 agentic 轮上限；0=不限（token 不限量）
const STALL_LIMIT = 3;                       // 同任务连续零改动 N 次标阻塞
const ABORT_TIMEOUT_MIN = 60;                // 单任务超 N 分钟无进展则 abort 重试
const SESSION_RETRY_LIMIT = 3;               // 陷阱7：当前任务连续 session_dropped N 次标阻塞（防 ctx-overflow 死循环）
// 死信队列兜底（lazy 拆：爆了才拆，不预先递归）
const FAILED_TASK_LIMIT = 5;                 // 真失败累计达此数 → watch 停（goal 整体太难/太碎）
const DLQ_SPLIT_LIMIT = 30;                  // splitTask 累计调用达此数 → 死循环兜底，队列清空进 failed_tasks 停
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
// 可观测性：events + night_run.log 都轮转（防 append-only 长跑涨到几百 MB）+ 心跳节流落盘（runOneTask 期间最长 60min，state.json 否则冻结）。
const EVENTS_ROTATE_LINES = 5000;   // events.jsonl 超 N 行触发轮转（保留近期、归档旧的）。0=不轮转
const EVENTS_ARCHIVE_KEEP = 1;      // 保留几个归档文件（events.jsonl.1, .2...）
const LOG_ROTATE_LINES = 5000;      // night_run.log 超 N 行触发轮转（同 events，防 append-only 无限涨）。0=不轮转
const LOG_ARCHIVE_KEEP = 1;          // 保留几个归档文件（night_run.log.1, .2...）
const HEARTBEAT_FLUSH_MS = 30_000;  // runOneTask 期间心跳落盘节流间隔（外部 agent 对比 last_heartbeat_at 判 watch 卡死）

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
  // 轮转 night_run.log（防 append-only 无限涨）。行数按写入累计，超 LOG_ROTATE_LINES 滚动归档。
  if (hasLimit(LOG_ROTATE_LINES) && ++logLineCount >= LOG_ROTATE_LINES) {
    logLineCount = 0;
    rotateLog();
  }
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

// 死信队列专用 helper（dead-letter-design §12 step2）：照 tickFirst/blockFirst 骨架用 splice。
// removeFirst：从 .task.md 移除第一个未完成任务行（爆掉的 task 入死信队列后调，避免下轮还跑它；
//   子项由 splitTask 拆出后 insertTasksBeforeFirst 插回原位置）。
function removeFirst() {
  if (!existsSync(TASK_FILE)) return;
  const text = readFileSync(TASK_FILE, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) {
      lines.splice(i, 1);
      atomicWriteFile(TASK_FILE, lines.join("\n"));
      return;
    }
  }
}

// insertTasksBeforeFirst：把子 task 行插到第一个未完成任务之前（保依赖顺序——子项是父项的细化，
//   应该在当前位置先做完，不能排到队伍后面）。taskLines 传入时已带 "- [ ] " 前缀。
function insertTasksBeforeFirst(taskLines: string[]) {
  if (taskLines.length === 0) return;
  if (!existsSync(TASK_FILE)) {
    atomicWriteFile(TASK_FILE, taskLines.join("\n") + "\n");
    return;
  }
  const text = readFileSync(TASK_FILE, "utf8");
  const lines = text.split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^- \[ \]/.test(lines[i])) break;
  }
  // 在第一个未完成任务行之前插入子项行（保留其后所有任务，含父项的兄弟任务）
  const newLines = [...lines.slice(0, i), ...taskLines, ...lines.slice(i)];
  atomicWriteFile(TASK_FILE, newLines.join("\n") + "\n");
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
  finalText: string;          // result.result（subtype 守卫后取），结局标记 OUTCOME:* 从这解析
}

// 上下文探针：ctx 偏重时先发 /compact deep 试压一轮，看能不能把会话压下来。
// /compact 是本地 slash 命令，headless 下作为 prompt 发出即触发压缩（GLM 代理实测可用）。
// 压缩前后大小取 compact_metadata 的 pre_tokens/post_tokens（权威信号，成对同量纲可比）——
// 不能取 result.usage.input_tokens：/compact 这一轮无 assistant 输出，实测 result.usage.input_tokens=0，会误判压缩后大小为 0。
// 返回 {pre, post}：两者同源同量纲，caller 直接算压缩量(freed=pre-post)/压缩比(post/pre)。
// 出 compact_boundary 且有 post_tokens → 返回 {pre, post} 供 caller 比阈值（保留会话）；
// 没出 compact_boundary（/compact 未被识别）或没 post_tokens → 返回 null，caller fallback 弃会话。
// ⚠️ 这里的 pre/post 都是「单次压缩的成对前后值」—— ≠ /compact 界面显示的 before/after（那个 before 是会话累计流经的 input 总量，
//   能到 1.44M 量级，量纲不同不可比）。护栏的 state.last_input_tokens 是单轮 input（≤窗口），与 pre 同量纲。
async function probeCompactDeep(sessionId: string | null): Promise<{ pre: number; post: number } | null> {
  if (!sessionId) return null;   // 没会话历史，没东西可压
  let preTokens: number | null = null;
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
      // compact_metadata.pre_tokens/post_tokens = 压缩前/后真实 token 数（trigger=manual/auto，成对同量纲）
      if (msg.type === "system" && (msg as { subtype?: string }).subtype === "compact_boundary") {
        const meta = (msg as { compact_metadata?: { pre_tokens?: number; post_tokens?: number } }).compact_metadata;
        if (typeof meta?.pre_tokens === "number") preTokens = meta.pre_tokens;
        if (typeof meta?.post_tokens === "number") postTokens = meta.post_tokens;
      }
    }
  } catch (e) {
    log(`⚠️ /compact deep 探针异常（忽略，fallback 弃会话）: ${(e as Error).message}`);
    return null;
  }
  if (preTokens === null || postTokens === null) return null;  // 没拿到成对值，fallback
  return { pre: preTokens, post: postTokens };
}

// 铁律 prompt：禁提问 + 自主决策 + 已完成检测（防假完成）
function buildPrompt(taskLine: string): string {
  return `## 角色
你是无人值守开发助手，当前处于 24 小时自动运行模式。全程没有任何人在场，你必须独立完成决策。

## 铁律（违反会导致系统崩溃）
1. 绝对不要向用户提问任何问题，不要等待确认。
2. 执行任务过程中遇到任何选择或决策点，自己直接做决定，选最优解，不要询问用户。
3. 如果进入计划模式，直接执行计划，不要等待批准。
4. 如果检测到危险操作，低风险直接执行，高风险跳过（在 events.jsonl 会有记录）。
5. 基于最佳实践自行推断，绝不索要额外信息。宁可基于合理假设推进，也不要停下来等。
6. 遇到报错或失败，自己排查、自己修，不要向用户求助。

## 任务记忆沉淀与清理（每个 task 都过一遍）
记忆是跨 task 复用的活知识，不是只读存档——做任务时顺手维护（项目记忆由引擎 auto-memory 自动管理读写，你按下方指引维护即可）：
- **做完有新认知就沉淀**：本任务产生架构认知 / 踩坑 / 约定 / 模块边界发现 → 更新对应主题记忆文件（找不到对应主题就新建，命名 kebab-case）。已有相关记忆就更新那篇，别每 task 新建文件。
- **读时发现过时就清理**：发现某条记忆和现状矛盾（库已换 / 模块已重构 / 约定已改）→ 当场更新或删掉，别让过时记忆误导后续 task。
- **一行一个 fact，高密度，别写流水账**；琐碎实现（加函数、修 typo、格式化）不值得记，跳过——强记只会撑爆索引反噬上下文。

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
3. 项目记忆（auto-memory）由引擎自动注入，按需 Read 相关条目了解背景（无关就跳过）。
4. 执行任务（代码写到文件）。遇到决策点自己拍板。

## 上下文预算（防撑爆，尤其代理模型上下文有限）
- 只读与当前任务直接相关的文件，不要扫全项目、不要批量 Read 源码树。
- 记忆按需读，别全读——大文件全读会撑爆上下文。
- 大文件用 Grep 定位再按行 Read，别整文件打开。
- 优先 grep/ls 验证再决定读不读，避免把无关文件灌进上下文。
- 有高价值认知就维护记忆（见上方「任务记忆沉淀与清理」），别只读不写让记忆停滞。

## 规则
- 一次只做一个任务。不要自己改 .task.md 勾选状态——打勾由外部脚本负责。
- 本轮结束时，回复最后一行单独输出结局标记，三选一，前面不许有其他文字：
  - \`OUTCOME:COMPLETED\` —— 本轮实际改了代码完成任务
  - \`OUTCOME:ALREADY_DONE\` —— 检查后判定任务代码已存在且实现完整（下一行附证据：Read 了哪些 文件:函数）
  - \`OUTCOME:BLOCKED\` —— 遇到无法自行解决的阻塞（下一行说明卡在哪）`;
}

// 当前 runOneTask 的 AbortController——提模块级让信号 handler 够得着（abort → SDK close 杀 claude 子进程）。
let activeAbort: AbortController | null = null;

async function runOneTask(taskLine: string, sessionId: string | null, onHeartbeat: () => void): Promise<RoundOutcome> {
  const ac = new AbortController();
  activeAbort = ac;
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
          onHeartbeat();                  // 节流落盘 last_heartbeat_at + pendingCounts（给外部 agent 看卡死）
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
        hooks: [async () => { lastHeartbeat = Date.now(); onHeartbeat(); return {}; }],
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
    if (activeAbort === ac) activeAbort = null;
  }

  return { result: resultMsg, wroteFiles, toolCalls, aborted, postTokens: null, maxTokens: capturedMaxTokens,
    // 结局标记 OUTCOME:* 从这段文本解析（同 splitTask L1168 / bootstrapTasks L1281 守卫写法：
    // success 取 r.result，错误分支无 result 字段退 errors 拼接；resultMsg 为 null 则空串）
    finalText: resultMsg
      ? (resultMsg.subtype === "success" ? (resultMsg.result ?? "") : (resultMsg.errors ?? []).join("\n"))
      : "" };
}

// ---------------- state.json + events.jsonl 持久化 ----------------

// 死信队列元素（3 字段）：爆掉的 task/goal 待拆（暂态，出队即移除父项，不做父子追踪——见 dead-letter-design §7）。
// type 区分爆点：goal=bootstrap 拆任务爆（子项独立 bootstrap）/ task=tick 干活爆（子项插回 .task.md）。两者本质同构。
interface DeadLetterItem {
  type: "goal" | "task";
  content: string;          // 爆掉的原内容（goal 文本 / task 行文本）
  ts: string;               // 入队时间（本地时间，同 now()）
}

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
  last_termination: { reason: "done" | "dead_letter_exhausted"; ts: string } | null; // 陷阱4：防完成后续 cron 刷 done；dead_letter_exhausted=死信队列兜底停
  last_input_tokens: number | null;  // 上轮上下文占用（result.usage.input_tokens），供下轮健康度判定
  ctx_max_tokens: number | null;     // 模型上下文窗口（getContextUsage 捕获一次，稳定）
  last_heartbeat_at: string | null;  // runOneTask 期间节流落盘的心跳（外部 agent 对比它判 watch 卡死）
  event_counts: Record<string, number>;  // 事件累计计数（轮转丢明细不丢计数，--report 读这）
  // 死信队列（dead-letter-design §4.2）：爆掉的 task/goal 待拆（暂态），failed_tasks=拆到底做不了（终态），dlq_split_count=splitTask 累计调用数（防无限拆死循环）
  dead_letter: DeadLetterItem[];    // 死信队列（爆掉的 task/goal 待拆，暂态）
  failed_tasks: DeadLetterItem[];   // 真失败册（拆到底做不了，终态只进不出）
  dlq_split_count: number;          // splitTask 累计调用次数（防无限拆死循环，达 DLQ_SPLIT_LIMIT 队列清空停）
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
  last_heartbeat_at: null,
  event_counts: {},
  dead_letter: [],
  failed_tasks: [],
  dlq_split_count: 0,
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
// 累计计数维护在模块级 pendingCounts，由心跳 flush / tick 出口写盘合并进 state.event_counts
// （轮转丢明细不丢计数；--report 读 state.event_counts 不再扫全文件）。
let eventLineCount = 0;  // 当前 events.jsonl 行数缓存（轮转后归零）
const pendingCounts: Record<string, number> = {};  // 自上次 flush 累计的事件计数
function appendEvent(type: string, data: Record<string, unknown>, ctx?: { tick_id?: string | null; loop_count?: number | null }) {
  const env: EventEnvelope = {
    ts: now(),
    type,
    tick_id: ctx?.tick_id ?? null,
    loop_count: ctx?.loop_count ?? null,
    data,
  };
  appendFileSync(EVENTS_FILE, JSON.stringify(env) + "\n");
  pendingCounts[type] = (pendingCounts[type] ?? 0) + 1;
  eventLineCount++;
  if (hasLimit(EVENTS_ROTATE_LINES) && eventLineCount >= EVENTS_ROTATE_LINES) {
    eventLineCount = 0;
    rotateEvents();
  }
}

// events.jsonl 轮转：rename 滚动归档（.1→.2 删最旧、当前→.1、新建空文件）。
// 同文件系统 rename 原子，归档文件名 events.jsonl.<n> 进 .gitignore。
function rotateEvents() {
  try {
    // 删最旧归档，从高到低滚动
    for (let i = EVENTS_ARCHIVE_KEEP; i >= 1; i--) {
      const src = `${EVENTS_FILE}.${i}`;
      const dst = `${EVENTS_FILE}.${i + 1}`;
      if (i === EVENTS_ARCHIVE_KEEP) {
        rmSync(src, { force: true });
      } else if (existsSync(src)) {
        renameSync(src, dst);
      }
    }
    // 当前 → .1，再新建空文件
    if (existsSync(EVENTS_FILE)) {
      renameSync(EVENTS_FILE, `${EVENTS_FILE}.1`);
    }
    writeFileSync(EVENTS_FILE, "");
    log(`📦 events.jsonl 轮转（保留 ${EVENTS_ARCHIVE_KEEP} 个归档）`);
  } catch (e) {
    log(`⚠️ events 轮转失败（忽略）: ${(e as Error).message}`);
  }
}

// night_run.log 轮转：rename 滚动归档（与 events.jsonl 同构，防 append-only 无限涨）。
// 归档文件名 night_run.log.<n>，.gitignore 用 night_run.log 通配一并忽略。
let logLineCount = 0;  // 当前 night_run.log 行数缓存（轮转后归零）
function rotateLog() {
  try {
    for (let i = LOG_ARCHIVE_KEEP; i >= 1; i--) {
      const src = `${LOG_FILE}.${i}`;
      const dst = `${LOG_FILE}.${i + 1}`;
      if (i === LOG_ARCHIVE_KEEP) {
        rmSync(src, { force: true });
      } else if (existsSync(src)) {
        renameSync(src, dst);
      }
    }
    if (existsSync(LOG_FILE)) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    writeFileSync(LOG_FILE, "");
    console.log(`📦 night_run.log 轮转（保留 ${LOG_ARCHIVE_KEEP} 个归档）`);
  } catch (e) {
    console.log(`⚠️ night_run.log 轮转失败（忽略）: ${(e as Error).message}`);
  }
}

// 把 pendingCounts 合并进 state.event_counts 并清空 pending。
// 由心跳节流回调 + tick 出口写盘前调用（高频 appendEvent 不直接写 state，省同步 I/O）。
function flushPendingCounts(state: StateJson) {
  let changed = false;
  for (const [k, v] of Object.entries(pendingCounts)) {
    if (v <= 0) continue;
    state.event_counts[k] = (state.event_counts[k] ?? 0) + v;
    pendingCounts[k] = 0;
    changed = true;
  }
  return changed;
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

// 统计某类型事件数：优先读 state.event_counts（全历史累计，轮转后仍准），回退扫当前 events.jsonl（旧 state 无此字段时）。
function countEvents(type: string): number {
  const s = readStateJson();
  if (Object.keys(s.event_counts ?? {}).length > 0) {
    return s.event_counts[type] ?? 0;
  }
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
  | { kind: "already_running" }
  | { kind: "dead_letter_split" }       // 死信队列出队拆分成功（goal 子项独立 bootstrap / task 子项插回 .task.md）
  | { kind: "dead_letter_split_failed" };// 死信队列出队但 splitTask 拆不出（自爆，进 failed_tasks，未达 FAILED_TASK_LIMIT 继续）

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

    // 步骤3.5: 死信队列出队处理（dead-letter-design §6.3）——优先于普通任务。
    // 出队 splitTask → 按 type 分流（goal→独立 bootstrap / task→插回 .task.md）+ 父立即移除 + dlq_split_count++。
    // 出队后本轮专门拆，不跑 runOneTask（一个 tick 干一件事，清晰易调试）。
    // 返回 dead_letter_split / dead_letter_split_failed / terminated，watch 收到后下一 tick 继续（tick 本身是单步，
    // 用 return 替代 continue，效果等价：watch 的 while(true) 会再调一次 tick）。
    if (state.dead_letter.length > 0) {
      // 死循环兜底（§6.3）：splitTask 累计调用太多 → 队列清空进 failed_tasks + 停 watch
      if (state.dlq_split_count >= DLQ_SPLIT_LIMIT) {
        log(`🚫 splitTask 累计 ${state.dlq_split_count} 次仍没消停，死信队列清空进真失败，停 watch`);
        appendEvent("dead_letter_exhausted", { split_count: state.dlq_split_count, limit: DLQ_SPLIT_LIMIT }, { tick_id: null, loop_count: state.loop_count });
        for (const item of state.dead_letter) state.failed_tasks.push(item);
        state.dead_letter = [];
        state.last_termination = { reason: "dead_letter_exhausted", ts: now() };
        state.last_tick_at = now();
        state.last_heartbeat_at = now();
        flushPendingCounts(state);
        writeStateJsonAtomic(state);
        return { kind: "terminated" };
      }

      tickId = genTickId();
      const dlTasks = readTasks();
      appendEvent("tick_started", { remaining: dlTasks.remaining, total: dlTasks.total, current_task: `[dead_letter:${state.dead_letter[0].type}]`, dead_letter_len: state.dead_letter.length }, { tick_id: tickId, loop_count: state.loop_count + 1 });
      state.loop_count++;
      state.status = "running";
      state.last_tick_at = now();
      state.last_tick_id = tickId;
      writeStateJsonAtomic(state);
      log("━".repeat(60));
      log(`🔄 第 ${state.loop_count} 轮 | 死信队列 ${state.dead_letter.length} 项 | tick_id=${tickId}`);

      const item = state.dead_letter[0];
      const children = await splitTask(item.content);   // 拆 N 子项（模型自决）
      state.dlq_split_count++;
      state.dead_letter.shift();   // 父项立即移除（不保留父子关系，见 §7）

      if (children.length === 0) {
        // splitTask 自爆 / 拆不出 → 进真失败册（dead-letter-design §6.3）
        log(`⚠️ splitTask 拆失败（可能自爆），进真失败：${item.content.slice(0, 80)}`);
        state.failed_tasks.push(item);
        appendEvent("task_failed", { content: item.content, reason: "split_failed" }, { tick_id: tickId, loop_count: state.loop_count });
        state.status = "idle";
        state.last_tick_at = now();
        state.last_heartbeat_at = now();
        // 真失败累计兜底（§6.4）：放这里而非 tick 出口，避免 continue 跳过出口检查导致迟一轮才停
        if (state.failed_tasks.length >= FAILED_TASK_LIMIT) {
          log(`🚫 真失败累计 ${state.failed_tasks.length} 个任务，goal 整体太难，停 watch 待人工介入`);
          appendEvent("dead_letter_exhausted", { failed_count: state.failed_tasks.length, limit: FAILED_TASK_LIMIT }, { tick_id: tickId, loop_count: state.loop_count });
          state.last_termination = { reason: "dead_letter_exhausted", ts: now() };
          flushPendingCounts(state);
          writeStateJsonAtomic(state);
          appendEvent("tick_completed", { outcome: "terminated" }, { tick_id: tickId, loop_count: state.loop_count });
          return { kind: "terminated" };
        }
        flushPendingCounts(state);
        writeStateJsonAtomic(state);
        appendEvent("tick_completed", { outcome: "dead_letter_split_failed" }, { tick_id: tickId, loop_count: state.loop_count });
        return { kind: "dead_letter_split_failed" };   // watch 继续，下一 tick 再出队
      }

      // 按 type 分流（goal/task 本质同构，都是"拆出更小的项继续推进"，但落地路径不同）
      if (item.type === "goal") {
        // 子 goal：逐个独立 bootstrap（各自拆成 task 列表写进 .task.md）
        appendEvent("task_split", { content: item.content, child_count: children.length, type: "goal" }, { tick_id: tickId, loop_count: state.loop_count });
        log(`📦 子 goal 拆出 ${children.length} 项，逐个独立 bootstrap`);
        for (const subGoal of children) {
          await bootstrapTasks(subGoal, true);   // append=true：子 goal 拆出的 task 追加进 .task.md，不覆盖前面子 goal 已写的
          // ⚠️ 独立 bootstrap 自己爆了？bootstrapTasks 内部已处理（§6.2 再入死信队列 type=goal），同构递归
        }
      } else {
        // 子 task：插回 .task.md 当前位置（保依赖顺序）
        insertTasksBeforeFirst(children);
        appendEvent("task_split", { content: item.content, child_count: children.length, type: "task" }, { tick_id: tickId, loop_count: state.loop_count });
        log(`📦 子 task 拆出 ${children.length} 项，插回 .task.md 当前位置`);
      }
      state.status = "idle";
      state.last_tick_at = now();
      state.last_heartbeat_at = now();
      flushPendingCounts(state);
      writeStateJsonAtomic(state);
      appendEvent("tick_completed", { outcome: "dead_letter_split" }, { tick_id: tickId, loop_count: state.loop_count });
      return { kind: "dead_letter_split" };   // watch 继续，下一 tick 跑刚插入的子 task（或继续出队下一个死信项）
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
      // 防假完成守卫：仅看是否有 [~] 阻塞标记（BLOCKED/stall 产生）→ suspected_false_completion
      // 放掉「全程零 commit」条件：完全信模型完成判定后，纯校验类/只读类 goal 天生零 commit，
      // 用零 commit 作假完成信号会误挂这类 goal。完成判定改由每轮 OUTCOME 标记 + 依据留痕兜底。
      // （had_any_commit 字段保留——gitCommitIfChanged 仍写它，只是收尾不再读它作判据。）
      if (blocked > 0) {
        log(`⚠️ remaining=0 但 ${blocked} 个 [~] 阻塞：疑假完成，挂起待人工核实（不设 last_termination）`);
        appendEvent("suspected_false_completion", { blocked, had_any_commit: state.had_any_commit, total }, { tick_id: tickId, loop_count: state.loop_count });
        state.status = "blocked_suspect";
        state.last_tick_at = now();
        state.last_tick_id = tickId;
        flushPendingCounts(state);
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
      flushPendingCounts(state);
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
        const probe = await probeCompactDeep(sessionId);
        if (probe !== null && max > 0 && probe.post < Math.floor(max * CTX_RECYCLE_RATIO)) {
          const freed = probe.pre - probe.post;
          const compressRatio = probe.pre > 0 ? +(probe.post / probe.pre).toFixed(3) : null;
          log(`✅ /compact deep 压成功：${probe.pre} → ${probe.post}（压掉 ${freed}，压缩至 ${compressRatio != null ? (compressRatio * 100).toFixed(1) + "%" : "?"}），保留会话继续 resume`);
          appendEvent("compact_probe_ok", {
            pre: probe.pre,                          // 压缩前 token（单次压缩的 pre_tokens，同量纲）
            post: probe.post,                         // 压缩后 token
            freed,                                    // 压缩量 = pre - post
            compress_ratio: compressRatio,            // 真压缩比 = post / pre（≤1，越小压得越多）
            trigger_threshold: CTX_RECYCLE_RATIO,     // 触发阈值（0.7）—— 不是压缩比，改名防误读
            max_tokens: max,                          // 模型上下文窗口
          }, { tick_id: tickId, loop_count: state.loop_count });
          state.last_input_tokens = probe.post;
        } else {
          // 探针没压下来（/compact 未被识别或压完仍超阈值）→ 直接弃旧会话开新会话
          log(`⚠️ /compact deep 未压到阈值（${probe ? `${probe.post}/${max}` : `null/${max}`}），弃旧会话下轮开新会话`);
          appendEvent("compact_probe_failed", {
            pre: probe?.pre ?? null,                  // 压缩前 token（探针异常/没出 boundary 时可能 null）
            post: probe?.post ?? null,                // 压缩后 token（可能 null 或仍超阈值）
            freed: probe ? probe.pre - probe.post : null,   // 压缩量（没跑成压缩则 null）
            compress_ratio: probe && probe.pre > 0 ? +(probe.post / probe.pre).toFixed(3) : null,  // 真压缩比（接近1=没压下来）
            trigger_threshold: CTX_RECYCLE_RATIO,
            max_tokens: max,
            session_dropped: true,                    // 标明此次探针失败后弃了会话
          }, { tick_id: tickId, loop_count: state.loop_count });
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
    // 心跳节流回调：runOneTask 期间最长 60min，否则 state.json 冻结在 tick 入口；
    // 节流每 HEARTBEAT_FLUSH_MS 落盘一次 last_heartbeat_at + flush pendingCounts，外部 agent 据此判 watch 卡死。
    let lastHeartbeatFlush = 0;
    const onHeartbeat = () => {
      const t = Date.now();
      if (t - lastHeartbeatFlush < HEARTBEAT_FLUSH_MS) return;  // 节流
      lastHeartbeatFlush = t;
      state.last_heartbeat_at = now();
      flushPendingCounts(state);
      writeStateJsonAtomic(state);
    };
    const { result, wroteFiles, toolCalls, aborted, maxTokens, finalText } = await runOneTask(taskLine, sessionId, onHeartbeat);

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
      // 记录上轮上下文占用，供下轮健康度判定。
      // 抓包确认（2026-07-25 真跑 13 轮，GLM 代理 192.168.241.10:3000 + glm-5.1）：
      //   usage.input_tokens 是单轮上报（10万-22万波动，非百万累计）；
      //   cache_creation/cache_read 恒 0（GLM 不报缓存命中，input_tokens 即真实单轮输入无低估）。
      //   故 `state.last_input_tokens = inTok` 可信，无需改用 getContextUsage().totalTokens。
      // 下行 usage 全字段日志：保留作可观测性诊断（非必需，但出问题时一眼看代理报了啥）。
      const usage = result.usage;
      if (usage) log(`📊 usage: ${JSON.stringify(usage)}`);
      const inTok = usage?.input_tokens;
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
        if (aborted) {
          // 看门狗超时：worker 卡死，任务可能不大 → 拆了拆出的子任务照样卡，继续走老 block（dead-letter-design §6.1）
          log(`🚧 连续 ${SESSION_RETRY_LIMIT} 次 session_dropped（aborted），标 [~] 阻塞跳过，推进下一任务`);
          blockFirst();
          appendEvent("task_blocked", { task: taskKey, reason: "aborted_timeout" }, { tick_id: tickId, loop_count: state.loop_count });
        } else {
          // ctx_overflow：task 太大一个会话装不下 → 入死信队列等拆（dead-letter-design §6.1）
          log(`🚧 连续 ${SESSION_RETRY_LIMIT} 次 session_dropped（ctx_overflow），task 太大入死信队列待拆`);
          state.dead_letter.push({ type: "task", content: taskLine, ts: now() });
          appendEvent("task_to_dlq", { task: taskKey }, { tick_id: tickId, loop_count: state.loop_count });
          removeFirst();   // 从 .task.md 移除原任务行（避免下轮还跑它），子项由 splitTask 拆出后插回
        }
        state.session_retries = 0;
        state.stall_task = null;
        state.stall_count = 0;
      }
      state.status = "ctx_overflow_retry";
      appendEvent("tick_completed", { outcome: "session_dropped" }, { tick_id: tickId, loop_count: state.loop_count });
      return { kind: "session_dropped" };
    }

    // 步骤15: 结局标记 × 写文件 对照分流（取代旧「只看 wroteFiles」单信号）
    // Claude 末尾输出 OUTCOME:COMPLETED/ALREADY_DONE/BLOCKED（约定见 buildPrompt 末尾），swallow 解析后与客观写动作对照：
    //   - 写了代码 → 事实优先，commit+打勾（不管 Claude 自报什么）
    //   - ALREADY_DONE + 没写 → 打勾推进（校验类跑通即完成 / 只读类检查后确认；依据存事件 evidence 事后追溯）
    //   - BLOCKED + 没写 → 直接 [~] 跳过（不等 stall 烧 3 轮）
    //   - 其余没写（COMPLETED-没动手可疑 / 未声明）→ stall
    const m = finalText.match(/OUTCOME:(COMPLETED|ALREADY_DONE|BLOCKED)/);
    const outcomeTag = m?.[1] ?? null;
    const didWrite = wroteFiles.length > 0;

    if (didWrite) {
      // 事实优先：写了代码 → commit + 打勾 [x]（哪怕 Claude 说 ALREADY_DONE 却改了文件，也以客观写动作为准）
      tickFirst();
      const committed = gitCommitIfChanged(taskLine);
      if (committed) state.had_any_commit = true;
      log(`⏱️ 第 ${state.loop_count} 轮结束：写入 ${wroteFiles.length} 文件 / ${toolCalls} 工具调用（${committed ? "已提交" : "无暂存"}）[outcome=${outcomeTag ?? "未声明"}]`);
      state.stall_task = null;
      state.stall_count = 0;
      state.session_retries = 0;
      appendEvent("task_completed", { task: taskKey, wrote_files: wroteFiles, committed, outcome: outcomeTag }, { tick_id: tickId, loop_count: state.loop_count });
    } else if (outcomeTag === "ALREADY_DONE") {
      // 判已完成（未写代码，如校验类任务跑通即完成 / 只读类检查后确认）→ 打勾 [x] 推进
      // 依据存进事件 evidence 事后可追溯（完全信模型完成判定 + 留痕）
      tickFirst();
      const committed = gitCommitIfChanged(taskLine);   // 校验/只读类无改动 → false，无 commit
      if (committed) state.had_any_commit = true;
      log(`✅ 任务判已完成（未写代码），打勾: ${taskKey}`);
      appendEvent("task_already_done", { task: taskKey, evidence: finalText.slice(0, 500), outcome: outcomeTag, via: "self_reported" }, { tick_id: tickId, loop_count: state.loop_count });
      state.stall_task = null;
      state.stall_count = 0;
      state.session_retries = 0;
    } else if (outcomeTag === "BLOCKED") {
      // 主动报卡 → 直接标 [~] 阻塞跳过，不等 stall 烧 3 轮
      blockFirst();
      log(`🚧 任务主动报阻塞，标 [~] 跳过: ${taskKey}`);
      appendEvent("task_blocked", { task: taskKey, reason: "self_reported_blocked", evidence: finalText.slice(0, 500) }, { tick_id: tickId, loop_count: state.loop_count });
      state.stall_task = null;
      state.stall_count = 0;
    } else {
      // 没写代码 + 不是 ALREADY_DONE/BLOCKED → stall（含 COMPLETED-没动手的可疑情况、UNKNOWN 未声明）
      state.stall_task = taskKey;
      state.stall_count++;
      log(`⏸️ 零改动空转 #${state.stall_count}: ${taskKey}`);
      appendEvent("task_stall", { task: taskKey, stall_count: state.stall_count, limit: STALL_LIMIT, outcome: outcomeTag }, { tick_id: tickId, loop_count: state.loop_count });
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
    state.last_heartbeat_at = now();  // tick 出口刷新心跳（与 last_tick_at 对齐，表示本轮刚结束、活着）
    flushPendingCounts(state);        // 把本轮 appendEvent 攒的 pending 计数合并进 state（tick 出口兜底）
    // 死信兜底（dead-letter-design §6.4）：真失败累计达限 → 停 watch
    // （出队的拆失败已就地检查；此处兜住其它路径产生的 failed_tasks，如未来扩展）
    if (state.failed_tasks.length >= FAILED_TASK_LIMIT) {
      log(`🚫 真失败累计 ${state.failed_tasks.length} 个任务，goal 整体太难，停 watch 待人工介入`);
      appendEvent("dead_letter_exhausted", { failed_count: state.failed_tasks.length, limit: FAILED_TASK_LIMIT }, { tick_id: tickId, loop_count: state.loop_count });
      state.last_termination = { reason: "dead_letter_exhausted", ts: now() };
      writeStateJsonAtomic(state);
      appendEvent("tick_completed", { outcome: "terminated" }, { tick_id: tickId, loop_count: state.loop_count });
      return { kind: "terminated" };
    }
    writeStateJsonAtomic(state);
    // 前三分支（写代码 / ALREADY_DONE / BLOCKED）都推进了任务（打勾或软/硬阻塞后过到下一任务），stall 才停。
    const advanced = didWrite || outcomeTag === "ALREADY_DONE" || outcomeTag === "BLOCKED";
    const outcome: TickOutcome["kind"] = advanced ? "advanced" : (state.stall_count > 0 ? "stalled" : "blocked");
    appendEvent("tick_completed", { outcome }, { tick_id: tickId, loop_count: state.loop_count });
    return advanced ? { kind: "advanced" } : (state.stall_count > 0 ? { kind: "stalled" } : { kind: "blocked" });
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
  // 守卫：已有 --watch 在跑就立即退出，不覆写 PID_FILE、不进 while 空转（每 30s 重试锁烧资源）。
  // flock（tick 级）已保证数据安全，此 PID 守卫是「快速失败」的软协调——对齐 README「第二个立即退出」。
  // TOCTOU（check 与 write 间另一进程介入）窗口极小，且 flock 兜底 tick 级互斥，可接受（PID 文件协调的固有限制，与 systemd 同理）。
  const wr = watchRunning();
  if (wr.running) {
    log(`已有 --watch 进程在跑（PID=${wr.pid}），本进程立即退出（不覆写 .pid、不空转）`);
    appendEvent("watch_already_running", { existing_pid: wr.pid });
    return;
  }
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
      // done/already_terminated/stopped/terminated 都是终态 → watch 退出。
      // terminated 含 suspected_false_completion（remaining=0 但有阻塞/零 commit，不设 last_termination 待人工介入）——
      // 若不退出会每 5s 重新 tick_started→suspected_false_completion→terminated 无限空转刷屏烧 token。
      // blocked 不在退出集：单个任务阻塞但还有未完成任务时该推进下一任务，watch 继续。
      if (["done", "already_terminated", "stopped", "terminated"].includes(o.kind)) break;
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

// 信号处理：--stop / Ctrl-C / kill 给 watch 发 SIGTERM/SIGINT 时，abort 正在跑的 query + 退出进程。
// 关键：不能只 abort 然后等 SDK 异步 close 杀子进程——SDK 的 close 是 stdin-EOF + 2s grace + SIGTERM + 5s SIGKILL，
// 而 process.exit(0) 立刻终止父进程，来不及走完，子进程会残留成孤儿继续烧 token。
// 所以 handler 里同步做三件事：abort（让 SDK 关闭）+ 清 PID 文件（process.exit 不走 finally）+ process.exit(0)，
// process.exit 会触发 SDK 的 process.on("exit") 钩子（mxe）对仍在的 claude 子进程补发 SIGTERM 做兜底。
// 之前 --stop 只杀 watch 父进程、claude 子进程变孤儿残留，需手动 pkill -f 'claude.*stream-json' 清——现不用了。
let stopping = false;
function handleSignal(sig: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${sig}，abort query + 退出（连带终止 claude 子进程）`);
  if (activeAbort) activeAbort.abort();
  rmSync(PID_FILE, { force: true });  // process.exit 不会走 watch finally，这里同步清
  process.exit(0);
}
process.on("SIGTERM", handleSignal);
process.on("SIGINT", handleSignal);

// ---------------- 死信队列：splitTask（dead-letter-design §5）----------------

// 把爆掉的 task/goal 拆成 N 个子项（N 模型自决——大任务可能 5+ 个、小任务可能 2 个，
// 不写死任何数字约束，唯一约束是「每个子项能单独会话内完成」）。
// 输出解析照抄 bootstrapTasks：text.split("\n").filter((l) => /^- \[ \]/.test(l))。
// query options 照 bootstrapTasks 模式：新会话（不 resume，区别于 probeCompactDeep）、
// bypassPermissions、disallowedTools 含 EnterPlanMode/ExitPlanMode/AskUserQuestion。
async function splitTask(content: string): Promise<string[]> {
  log(`🔧 splitTask 拆分（模型自决子项数）：${content.slice(0, 80)}`);
  const q = query({
    prompt: `## 角色
你是无人值守开发助手。下方给你一个"一次装不下、爆掉了"的 task（或 goal）。把它拆成若干个独立、可单独会话内完成的子 task。

## 铁律
1. 绝对不要向用户提问任何问题，不要等待确认。
2. 遇到选择点自己直接做决定。
3. 子项数量完全由你判断：拆少了下轮还爆就再拆（反馈驱动），拆多了能装下就行。不限制数量。
4. 唯一约束：每个子 task 要能在单个会话内独立完成（同 bootstrap 小任务约束）。
5. 子项之间保依赖顺序排列。

## 输出格式（同 bootstrap）
只输出任务列表，每行一个，不要其它内容：
- [ ] 子 task 描述
- [ ] 子 task 描述
...

## 要拆的内容
${content}`,
    options: {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: hasLimit(BOOTSTRAP_MAX_TURNS) ? BOOTSTRAP_MAX_TURNS : undefined,
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
  log(`🔧 splitTask 拆出 ${taskLines.length} 个子项`);
  return taskLines;
}

// ---------------- bootstrap：知识优先，禁探索（防拆任务爆上下文）----------------
// 旧设计让 LLM 自己 agentic 探索项目拿上下文 → 要么探索过度爆上下文（Claude Code 拆得准但爆）、
// 要么没上下文纯靠 goal 猜（Hermes 拆得不准）。根因是「谁拿项目上下文」绑在了 LLM 身上。
// 改法：把最高价值的现成知识（CLAUDE.md）由 orchestrator 代码直接读出来喂进 prompt 当基线，
// 模型只基于基线做 PM 式结构拆解——prompt 明确禁止主动读文件探索。
// 拆任务是结构判断（目标+架构+约束），不需要实现细节；读文件探索才是 bootstrap 爆上下文的根因。
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

// 读最高价值的现成知识喂给 bootstrap：CLAUDE.md（项目说明书，全文，通常不大）。
// 喂完基线后锁死探索——拆任务是 PM 式结构判断，prompt 明确禁止主动读文件（防爆，根因是探索而非基线）。
// 项目记忆（auto-memory）由引擎 query() 自动注入（system-reminder 形式，和 CLI 同份），
// swallow 不显式喂——避免重复占上下文（防爆），且 worker 能自然看到。
function loadProjectKnowledge(): string {
  const parts: string[] = [];
  if (existsSync("CLAUDE.md")) {
    parts.push("## CLAUDE.md（项目说明书）\n" + readFileSync("CLAUDE.md", "utf8"));
  }
  if (parts.length === 0) {
    // 真新工程/没用过 claude code → 退路：代码轻量勘察当探索起点
    parts.push("## 项目结构（自动勘察）\n" + surveyProjectTree());
  }
  let text = parts.join("\n\n");
  if (text.length > 20_000) text = text.slice(0, 20_000) + "\n...(已截断，详见项目文件)";  // 截断防爆
  return text;
}

async function bootstrapTasks(goal: string, append = false) {
  log("首次运行，拆解任务...");
  log(`目标：${goal}`);
  const knowledge = loadProjectKnowledge();
  log(`📚 已加载项目知识 ${knowledge.length} 字符（CLAUDE.md/memory 基线，禁探索）`);
  const q = query({
    // 高价值现成知识由代码喂进来当基线；拆任务是 PM 式结构判断（目标+架构+约束），不需要实现细节，
    // 读文件探索是 bootstrap 爆上下文的根因——prompt 明令禁止主动读文件，从根上预防爆，死信兜底是补救，两者互补。
    prompt: `像项目经理一样，根据用户目标把工作拆成最小可执行任务列表。下方【项目背景】（CLAUDE.md / 勘察）是为你准备的结构与约束基线，吃透它即可。拆任务是结构判断、不需要实现细节——不要主动读文件、不要探索代码，只基于已提供的背景拆。

${knowledge}

用户目标：${goal}
要求：
- 每个任务足够小（一个函数、一个文件、一个接口），一个会话内能独立完成
- 按依赖顺序排列
- 输出格式只有任务列表，每行一个：
- [ ] 任务描述
- [ ] 任务描述
...

输出完所有任务后，最后单独一行输出哨兵标记 <!-- END_OF_TASKS -->（用于检测输出是否被截断）。`,
    options: {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: hasLimit(BOOTSTRAP_MAX_TURNS) ? BOOTSTRAP_MAX_TURNS : undefined,
      // 不禁文件工具：CLAUDE.md 当基线由代码喂进来，但 prompt 已明令禁止主动探索——靠措辞引导而非硬禁。
      // 硬禁 Read/Grep 太重，万一真要瞄一眼目录会卡死；CLAUDE.md 不靠工具读，禁探索不影响基线注入。
      disallowedTools: ["EnterPlanMode", "ExitPlanMode", "AskUserQuestion"],
    },
  });
  let text = "";
  let bootstrapOverflow = false;   // ctx_overflow 检测（dead-letter-design §6.2）
  try {
    for await (const msg of q) {
      if (msg.type === "result") {
        const r = msg as SDKResultMessage;
        // ctx_overflow 判定照 tick L806 同款结构化判法（subtype + errors/stop_reason，不 stringify+正则）
        if (r.subtype === "error_during_execution" && (
          r.errors?.some((e) => /context|exceed|too long/i.test(e))
          || /context/i.test(r.stop_reason ?? "")
        )) {
          bootstrapOverflow = true;
        }
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
  } catch (e) {
    // ctx 超限（如 400 "input longer than the model's context length"）在迭代期直接抛异常，
    // 到不了上面 result 消息的结构化判定。照 runOneTask L440 try/catch 对称补：命中 ctx 关键词
    // → 置 bootstrapOverflow 走已有死信分流（下方 bootstrapOverflow||truncated 分支，goal 入 DLQ）；
    // 非 ctx 类（鉴权/网络等）仍上抛——不该静默吞，让 main().catch 记完整栈再退出。
    // （对称 tick L991 isCtxOverflow 关键词，单一来源同款正则。）
    const errMsg = (e as Error).message ?? String(e);
    if (/context|exceed|too long/i.test(errMsg)) {
      bootstrapOverflow = true;
    } else {
      log(`⚠️ bootstrap query 异常: ${errMsg}`);
      throw e;
    }
  }
  const taskLines = text.split("\n").filter((l) => /^- \[ \]/.test(l));
  // 截断检测（dead-letter-design §6.2）：哨兵未出现 = 输出可能被截断，taskLines 数量可能不全。
  const truncated = !text.includes("<!-- END_OF_TASKS -->");

  if (bootstrapOverflow || truncated) {
    // goal 太大一次拆不完 → 入死信队列 type=goal，让 splitTask 拆成子 goal 逐个独立 bootstrap（§6.3 出队分流）
    log(`💥 bootstrap ${bootstrapOverflow ? "ctx_overflow" : `输出截断（${taskLines.length} 个任务可能不完整）`}，goal 入死信队列待拆`);
    const s = readStateJson();
    s.dead_letter.push({ type: "goal", content: goal, ts: now() });
    appendEvent("bootstrap_to_dlq", { goal, reason: bootstrapOverflow ? "ctx_overflow" : "truncate", partial_count: taskLines.length });
    writeStateJsonAtomic(s);
    return;   // 不 process.exit(1)，让 watch 继续跑处理死信队列（§6.3 出队逐个独立 bootstrap）
  }

  // append=true：死信队列 goal 分流逐个独立 bootstrap 时——子 goal 拆出的 task 追加进 .task.md
  // （不覆盖前面子 goal 已写的任务）。主路径（初始 bootstrap）默认 false 覆盖写合理（新 goal 重拆）。
  if (append && existsSync(TASK_FILE)) {
    const prev = readFileSync(TASK_FILE, "utf8").replace(/\n+$/, "");
    atomicWriteFile(TASK_FILE, (prev ? prev + "\n" : "") + taskLines.join("\n") + "\n");
  } else {
    atomicWriteFile(TASK_FILE, taskLines.join("\n") + "\n");
  }
  if (taskLines.length === 0) {
    log("❌ 任务拆解失败");
    process.exit(1);
  }
  log(`✅ 共 ${taskLines.length} 个任务${append ? "（追加进 .task.md）" : ""}`);
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

// 机器可读的结构化状态快照（--status --json 输出）。
// 把 state.json + .task.md 进度 + watch 进程 + events 末尾汇成单一 JSON 对象，
// 外部工具（python/awk/jq/任何能读 JSON 的）无需解析人类可读文本即可消费，跨平台零环境依赖。
// 死信队列摘要（--status 显示用，dead-letter-design §9）：不只计数，人工要看到哪些 task/goal 做不了。
// 每项截断到 80 字符防刷屏，failed_tasks 全量列（终态只进不出，人工要核实）。
function summarizeDeadLetter(items: DeadLetterItem[]): { type: string; content: string; ts: string }[] {
  return items.map((it) => ({ type: it.type, content: it.content.slice(0, 80), ts: it.ts }));
}

function buildStatusSnapshot() {
  const s = readStateJson();
  const { total, remaining, done, blocked } = readTasks();
  const wr = watchRunning();
  const pct = s.ctx_max_tokens !== null && s.last_input_tokens !== null && s.ctx_max_tokens > 0
    ? Math.round((s.last_input_tokens / s.ctx_max_tokens) * 100) : null;
  return {
    status: s.status,
    goal: s.goal || null,
    tasks: { total, done, blocked, remaining },
    loop_count: s.loop_count,
    context: s.ctx_max_tokens !== null && s.last_input_tokens !== null
      ? { input_tokens: s.last_input_tokens, max_tokens: s.ctx_max_tokens, pct, recycle_ratio: CTX_RECYCLE_RATIO }
      : null,
    had_any_commit: s.had_any_commit,
    stall_task: s.stall_task,
    stall_count: s.stall_count,
    stall_limit: STALL_LIMIT,
    session_retries: s.session_retries,
    session_retry_limit: SESSION_RETRY_LIMIT,
    dead_letter: {
      queue_len: s.dead_letter.length,
      dlq_split_count: s.dlq_split_count,
      dlq_split_limit: DLQ_SPLIT_LIMIT,
      failed_count: s.failed_tasks.length,
      failed_task_limit: FAILED_TASK_LIMIT,
      queue: summarizeDeadLetter(s.dead_letter),     // 待拆（暂态）
      failed: summarizeDeadLetter(s.failed_tasks),   // 拆到底做不了（终态，人工核实）
    },
    last_tick_at: s.last_tick_at,
    last_heartbeat_at: s.last_heartbeat_at,
    heartbeat_stale_min: ABORT_TIMEOUT_MIN,
    last_tick_id: s.last_tick_id,
    last_termination: s.last_termination,
    watch: { running: wr.running, pid: wr.pid },
    session_id: readSessionId(),
    event_counts: s.event_counts,
    recent_events: readEventsTail(8),
  };
}

function showStatus(json: boolean) {
  if (json) {
    console.log(JSON.stringify(buildStatusSnapshot(), null, 2));
    return;
  }
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
  // 死信队列（dead-letter-design §9）：队列长度 + splitTask 累计 + 真失败册内容摘要（人工要看到哪些做不了）
  console.log(`死信队列: ${s.dead_letter.length} 项待拆 | splitTask 累计 ${s.dlq_split_count}/${DLQ_SPLIT_LIMIT} | 真失败 ${s.failed_tasks.length}/${FAILED_TASK_LIMIT}`);
  if (s.dead_letter.length > 0) {
    console.log("  待拆（暂态）:");
    for (const it of s.dead_letter) {
      console.log(`    [${it.type}] ${it.content.slice(0, 80)} @ ${it.ts}`);
    }
  }
  if (s.failed_tasks.length > 0) {
    console.log("  真失败（终态，人工核实）:");
    for (const it of s.failed_tasks) {
      console.log(`    [${it.type}] ${it.content.slice(0, 80)} @ ${it.ts}`);
    }
  }
  console.log(`last_tick_at: ${s.last_tick_at ?? "(无)"}`);
  console.log(`last_heartbeat_at: ${s.last_heartbeat_at ?? "(无)"}${s.last_heartbeat_at ? `（外部 agent 对比当前时间判卡死，阈值 > ${ABORT_TIMEOUT_MIN}min）` : ""}`);
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
  console.log(`  task_already_done: ${countEvents("task_already_done")}（自报完成·依据留痕）`);
  console.log(`  task_blocked: ${countEvents("task_blocked")}`);
  console.log(`  task_stall: ${countEvents("task_stall")}`);
  console.log(`  session_dropped: ${countEvents("session_dropped")}`);
  console.log(`  aborted: ${countEvents("aborted")}`);
  // 死信队列事件（dead-letter-design §9）
  console.log(`  task_to_dlq: ${countEvents("task_to_dlq")}`);
  console.log(`  bootstrap_to_dlq: ${countEvents("bootstrap_to_dlq")}`);
  console.log(`  task_split: ${countEvents("task_split")}`);
  console.log(`  task_failed: ${countEvents("task_failed")}`);
  console.log(`  dead_letter_exhausted: ${countEvents("dead_letter_exhausted")}`);
  // 死信队列状态摘要
  console.log(`\n--- 死信队列 ---`);
  console.log(`  待拆队列: ${s.dead_letter.length} 项 | splitTask 累计 ${s.dlq_split_count}/${DLQ_SPLIT_LIMIT}`);
  console.log(`  真失败册: ${s.failed_tasks.length}/${FAILED_TASK_LIMIT}（达限停 watch）`);
  if (s.failed_tasks.length > 0) {
    console.log("  真失败内容（终态，人工核实）:");
    for (const it of s.failed_tasks) {
      console.log(`    [${it.type}] ${it.content.slice(0, 80)} @ ${it.ts}`);
    }
  }

  const wr = watchRunning();
  console.log(`\n--watch 进程: ${wr.running ? `运行中 PID=${wr.pid}` : "未运行"}`);

  // night_run.log 兜底 grep（保留历史异常排查能力）。读当前文件 + 归档（.1）拼接，轮转后不丢历史。
  const logPieces = [LOG_FILE, `${LOG_FILE}.1`];
  const logText = logPieces.filter(existsSync).map((f) => readFileSync(f, "utf8")).join("\n");
  if (logText) {
    console.log("\n--- night_run.log 异常尾 20 条 ---");
    const errs = logText.split("\n").filter((l) => /错误|失败|❌|异常|假死|空转|阻塞|stale|crash|崩溃/.test(l)).slice(-20);
    console.log(errs.length ? errs.join("\n") : "（未发现）");
  }
}

// 陷阱3: --stop 写 .stop 哨兵 + 给 --watch 进程发 SIGTERM。
// SIGTERM 由 watch 的 handleSignal 捕获 → abort 正在跑的 query → SDK kill claude 子进程（父子一起干净停）。
// 不再需要 pkill -f 'claude.*stream-json' 手动清孤儿子进程。
function stopAll() {
  log("收到 --stop 指令，写 .stop 哨兵");
  writeFileSync(STOP_FILE, `${now()} PID=${process.pid}\n`);
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, "utf8"));
    if (!isNaN(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`已发送 SIGTERM 给 --watch 进程 PID=${pid}（会连带终止 claude 子进程）`);
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

// --resume = 恢复运行：删 .stop 哨兵 + 若 watch 没在跑就拉起。
// 语义对齐「resume = 恢复运行」，而非旧的「只删哨兵」（旧版在 --stop 已杀进程的场景下是空操作，
// 用户得再跑一次 run.sh 才真正恢复——Hermes 踩过坑）。goal 从 state.json 读，无需用户再传。
async function resumeRun() {
  if (existsSync(STOP_FILE)) {
    rmSync(STOP_FILE, { force: true });
    log("已删除 .stop 哨兵");
  } else {
    log("无 .stop 哨兵");
  }
  const { running, pid } = watchRunning();
  if (running) {
    log(`watch 进程已在跑（PID=${pid}），哨兵已清，下次 tick 自动继续推进`);
    return;
  }
  const goal = existsSync(STATE_FILE) ? readStateJson().goal : "";
  if (!goal) {
    console.error("无法恢复：无 .stop 哨兵可清、且 state.json 无 goal，无恢复点。直接跑 bash <skill目录>/run.sh --cwd <项目> \"目标\" 重新开始。");
    process.exit(1);
  }
  log(`watch 未在跑，从 state.json 恢复点拉起（goal: ${goal.slice(0, 60)}...）`);
  await watch(goal);
}

// ---------------- 入口 ----------------

// 解析命令行（用 node:util parseArgs，零依赖 Node 18+）：
// --cwd <dir> 可放任意位置；--watch/--status/--report/--stop/--resume 控制 action；goal 为位置参数。
function parseArgs(argv: string[]): {
  goal?: string; cwd?: string;
  action?: "status" | "report" | "stop" | "resume" | "watch";
  json?: boolean;
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
        json: { type: "boolean", default: false },
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
  return { goal, cwd, action, json: values.json === true };
}

function preflightEnv() {
  const key = process.env.ANTHROPIC_API_KEY;
  const envFile = process.env.SWALLOW_ENV_FILE || `${homedir()}/.config/swallow/swallow.env`;
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
  const { goal, cwd, action, json } = parseArgs(process.argv.slice(2));

  // --cwd > SWALLOW_PROJECT env > 当前目录。chdir 后产物/git/会话目录三者统一。
  const targetCwd = cwd ? resolve(cwd) : (process.env.SWALLOW_PROJECT ? resolve(process.env.SWALLOW_PROJECT) : process.cwd());
  if (!existsSync(targetCwd) || !statSync(targetCwd).isDirectory()) {
    console.error(`目标目录不存在或非目录: ${targetCwd}`);
    process.exit(1);
  }
  process.chdir(targetCwd);

  // 预检仅对起 query 的动作（--watch/裸跑）做；只读/操控动作不挡。
  if (action === "watch" || !action) preflightEnv();

  if (action === "status") { showStatus(json ?? false); return; }
  if (action === "report") { showReport(); return; }
  if (action === "stop") { stopAll(); return; }
  if (action === "resume") { await resumeRun(); return; }   // resume 可能拉起 watch（async）

  // --watch 或裸跑
  if (action === "watch" || !action) {
    if (!goal && !existsSync(TASK_FILE)) {
      console.error('首次运行需要指定目标，例如：\n  bash <skill目录>/run.sh --cwd /path/to/project --watch "构建一个Go REST API"');
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
