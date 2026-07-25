# swallow

24 小时无人值守开发 orchestrator —— 用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 驱动 Claude 自主完成一整个开发目标。

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

> 核心理念：**重但稳 + 使用简单**。长跑拆成幂等单步 `tick`，状态双层落盘，进程崩溃天然可恢复；orchestrator 只管推进 + 结果结构化落盘，战报由外部 agent 读结果自行发送。

## 安装

两种入口，装的是同一个 `install.sh`——按你是人还是智能体挑一个：

### 方式一 · `.sh`：一条命令（人 / 智能体直接执行）

```bash
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash
```

### 方式二 · `.md`：给智能体读（它读完自行装）

把这个地址发给你的 AI 助手：

```
https://raw.githubusercontent.com/free-wyq/swallow/main/install.md
```

让它读这个文档、按文档执行上面的 bash 即可装好。适合让 agent 自主配置、或不想手动敲命令的场景。

---

两种方式都装到中立路径（不碰任何 agent 私有目录），装完即用 `swallow --cwd <项目> "目标"`。卸载/重装/升级见 [install.md](install.md)。

---

## 架构图

### 整体：推进 + 结果结构化落盘 + 外部 agent 读结果发战报

```mermaid
flowchart TB
    subgraph HOST["⚙️ 主机配置 · Linux/macOS（~/.config/）"]
      ENV[("swallow.env<br/>密钥 + 代理/模型")]
    end

    subgraph PROJ["📁 目标项目（--cwd 指向）· 产物写入处 + git commit 仓库"]
      direction TB
      KNOW[("CLAUDE.md / .claude/memory<br/>已有知识")]
      TASK[(".task.md · 进度真相源")]
      STATE[("state.json · 恢复点<br/>原子写")]
      EVENTS[("events.jsonl<br/>append-only 审计")]
    end

    subgraph SCRIPT["🛠️ swallow orchestrator（脚本）· --watch 长进程"]
      direction TB
      BOOT["bootstrap 拆任务 · query()"]
      TICK["tick 幂等单步 · while 循环"]
      RUN["runOneTask · query()"]
      SPLIT["splitTask 拆子项 · query()（爆才调）"]
      DLQ[("state.dead_letter<br/>死信队列 lazy 拆")]
      SDK["claude-agent-sdk（npm 包）"]
      CLI["claude 引擎（随 SDK 打包）"]
      BOOT --> TICK
      TICK -->|"读首个未完成"| RUN
      RUN --> SDK
      SDK -->|"spawn 子进程"| CLI
      CLI -.->|"PostToolUse 回调"| RUN
      RUN -->|"ctx_overflow 达限"| DLQ
      BOOT -->|"爆/截断"| DLQ
      DLQ --> SPLIT
      SPLIT -->|"子 task 插回 / 子 goal 独立 bootstrap"| TICK
    end

    subgraph EXTBOX["📡 外部 agent / 用户（脚本之外）"]
      direction LR
      Ext([定时读结果])
      Push([自行组织发战报])
      User([拉起 --watch])
    end

    User -->|"拉起"| BOOT
    KNOW -->|"loadProjectKnowledge 喂基线"| BOOT
    ENV -.->|"密钥/代理/模型"| BOOT
    BOOT -->|"写出"| TASK
    ENV -.->|"密钥/模型"| RUN
    TICK -->|"原子写状态"| STATE
    TICK --> EVENTS
    TICK -->|"打勾 [x]/[~]"| TASK
    Ext -->|"读已落盘结果"| STATE
    Ext -.-> Push

    style HOST fill:#fff9c4,stroke:#f9a825,stroke-width:2px
    style PROJ fill:#f1f8e9,stroke:#2e7d32,stroke-width:2px
    style SCRIPT fill:#fff8e1,stroke:#e65100,stroke-width:2px
    style EXTBOX fill:#e8f4fd,stroke:#1565c0,stroke-width:2px
    style STATE fill:#c8e6c9
    style EVENTS fill:#bbdefb
    style TICK fill:#ffe0b2
    style SDK fill:#e8f5e9
    style CLI fill:#ffe0b2
    style KNOW fill:#e1bee7
    style ENV fill:#fff59d
    style DLQ fill:#ffccbc,stroke:#bf360c
    style SPLIT fill:#ffe0b2
```

调用链一图看清：**用户/外部 agent** 拉起 `--watch` → orchestrator 脚本的 `runOneTask` 进程内调 **SDK**（`query()`）→ SDK spawn 一个 **claude 引擎**子进程跑工具调用 → 引擎的 `PostToolUse` hook 把真实文件写入事件回调给脚本。**引擎是随 SDK 打包的 `claude` 二进制**（`optionalDependencies` 按平台自动拉，npm install 即装齐），不是系统 `which claude`——用户无需另装 Claude Code，唯一前提 Node 18+。外部 agent 另起定时**读已落盘结果**（state.json/events.jsonl/.task.md）自行组织发战报，与脚本互不依赖。

**死信队列分支（爆才走）**：runOneTask 撞 ctx_overflow 达限 / bootstrap 爆或截断 → 内容入 `state.dead_letter` → 下 tick 优先出队，`splitTask` 拆子项回插 `.task.md`（task 型）或子 goal 独立 bootstrap（goal 型），拆不出的进 `failed_tasks`。两兜底防死循环：`failed_tasks>=5`（横向，不同 task 各自拆不出累计）/ `dlq_split_count>=30`（纵向，同几个 task 无限拆），达任一即 watch 停。详见 [docs/dead-letter-design.md](docs/dead-letter-design.md)。

四个边界一图看清（虚线=读取/喂入，实线=主推进流）：
- ⚙️ **主机配置（黄框）**——`~/.config/swallow.env` 是 Linux/macOS 主机路径（XDG 约定），存密钥 + 代理/模型。不属项目、不属脚本：脚本启动时读进 env，已 export 的不覆盖。限额写死在脚本（见橙框），不在这。
- 📁 **项目边界（绿框）**——`--cwd` 指向的目标项目：已有知识（CLAUDE.md/memory）+ 全部产物（.task.md/state.json/events.jsonl）都落在它目录里，git commit 进它仓库。
- 🛠️ **脚本边界（橙框）**——swallow orchestrator 本体（`orchestrator.ts` 的 `--watch` 进程）：bootstrap 拆解 + tick 执行是两个独立 `query()`。**限额写死在脚本顶部常量**（token 不限量，轮数护栏纯属挡路 → 一律 0=不限；行为护栏留正数防死循环），不读 swallow.env；swallow.env 只喂密钥/代理/模型。
- 📡 **外部 agent 边界（蓝框）**——脚本之外的角色（用户 / claw 等）：**拉起** `--watch` 启动推进，另起定时**读已落盘结果**自行组织发战报。与脚本互不依赖（任一方挂了不影响另一方）。

### 崩溃恢复时序

```mermaid
sequenceDiagram
    participant W as --watch 进程
    participant S as state.json
    participant E as events.jsonl
    participant T as 下一个 tick 进程

    W->>E: tick_started (tick_id=A)
    W->>S: status=running, loop_count=N
    Note over W: runOneTask 执行中...
    Note over W: 💀 kill -9 进程被强杀
    Note over E: tick_started(A) 无配对 tick_completed<br/>= 该 tick 崩溃（可检测）

    Note over T: 60s 后锁 stale 自动 takeover
    T->>S: 读 state.json（loop_count=N）
    T->>E: 读到 tick_started(A) 无配对
    T->>E: tick_started (tick_id=B)
    Note over T: 从崩溃处续跑同任务<br/>loop_count=N+1<br/>state 不丢 / 不重复打勾
```

---

## 快速开始

```bash
# 1. 一条命令安装（agent 无关，装到 ~/.local）
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash

# 2. 配密钥（非交互调度器不 source ~/.bashrc，写进 swallow.env 才拿得到）
cp ~/.local/share/swallow/swallow.env.example ~/.config/swallow.env
chmod 600 ~/.config/swallow.env   # 编辑填 ANTHROPIC_API_KEY=sk-...（走代理再加 ANTHROPIC_BASE_URL/ANTHROPIC_MODEL）

# 3. 跑（产物写在 --cwd 指定的项目目录）
swallow --cwd /path/to/project "构建一个 Go REST API"
```

### 配置（密钥 / 代理 / 模型）

cron / systemd / hermes cron 跑**干净 env 不 source `~/.bashrc`**，密钥得写进 `~/.config/swallow.env`，orchestrator 启动自动读（已 export 的不覆盖）。

| 变量 | 必填 | 含义 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 是 | 鉴权（写进 swallow.env） |
| `ANTHROPIC_BASE_URL` | 代理才填 | 走代理/中转才填 |
| `ANTHROPIC_MODEL` 等 | 代理才填 | 走代理时指定模型名 |

**限额不在这里**——写死在 `orchestrator.ts` 顶部常量（token 不限量场景下轮数护栏纯属挡路，一律 `0 = 不限`；行为护栏 `STALL_LIMIT=3` / `ABORT_TIMEOUT_MIN=60` / `SESSION_RETRY_LIMIT=3` / `FAILED_TASK_LIMIT=5` / `DLQ_SPLIT_LIMIT=30` 留正数防死循环）。要改改代码，不读 swallow.env。详见 [install.md](install.md)。

## 命令一览

| 命令 | 作用 |
|---|---|
| `swallow --cwd <proj> "目标"` | 裸跑 = `--watch`，自驱跑到完成 |
| `swallow --cwd <proj> --watch "目标"` | 显式自驱（bootstrap + `while(tick)`） |
| `swallow --cwd <proj> --status` | 实时状态（多行，给人看） |
| `swallow --cwd <proj> --status --json` | 结构化 JSON（给程序读，跨平台零依赖） |
| `swallow --cwd <proj> --report` | 运行报告 |
| `swallow --cwd <proj> --stop` | 停（写 `.stop` 哨兵 + 杀 `--watch`） |
| `swallow --cwd <proj> --resume` | 清 `.stop` 哨兵恢复 |

`--cwd` 决定三件事，三者统一：① 产物写入处 ② `git commit` 的仓库 ③ 会话工作目录。不传则回退 `SWALLOW_PROJECT` 环境变量或当前目录。**别在 swallow 仓库根目录裸跑**——会把产物写进 swallow 仓库并 commit 它。

> 未装 `swallow` 命令、直接在 swallow 仓库内开发时，`swallow` 等价于 `npx tsx orchestrator.ts`。

---

## 推进 + 结构化结果 + 外部发战报

- **推进**：`--watch` 长进程，一次拉起自驱跑到完成。内部是幂等 `tick()`（bootstrap 拆任务 → `while(tick())`，每轮 commit），崩了重启续跑。推进不依赖外部触发。
- **结果落盘**：每轮把进度/状态结构化写进 `state.json`（恢复点，原子写）+ `events.jsonl`（append-only 审计流）。`.task.md` 是进度真相源。
- **战报**：orchestrator **不发**。由外部 agent 定时读 state/events/.task.md 这些结构化结果，自行组织文案发战报。文案、频道、频率全由 agent 定。

三者解耦：推进靠 `--watch` 自管，结果可靠落盘，战报由外部 agent 读结果自行组织。watch 挂了不影响外部 agent 读已落盘的结果发战报；外部 agent 挂了不影响 watch 推进。

```bash
# 推进（一次）
swallow --cwd /path/to/project "构建一个 Go REST API"

# 外部 agent 定时读结果发战报（由该 agent 的定时机制实现，读结构化文件即可）
#   cat /path/to/project/state.json
#   tail -8 /path/to/project/events.jsonl
```

战报怎么发是独立工作，orchestrator 本身不改、也不掺和。接入实战（拉起 + 定时战报 + 微信推送）见 [docs/hermes-guide.md](docs/hermes-guide.md) / [docs/claude-code-guide.md](docs/claude-code-guide.md)。

## 注册成 skill（可选，agent 自行推理）

`skill/` 是一个可被 agent 加载的 skill（含 `SKILL.md`）。多数 agent 的 skill 扫描器用 find/glob 遍历 skills 目录、**默认不跟符号链接进子目录**——symlink 进去的 skill 扫描器看不见。所以注册时**拷成真目录**而非 symlink：

```bash
# 推理你 agent 的 skills 目录（常见：~/.claude/skills · ~/.codex/skills · ~/.gemini/skills · ~/.cursor/skills · ~/.hermes/skills）
SKILLS_DIR=~/.claude/skills
mkdir -p "$SKILLS_DIR"; rm -rf "$SKILLS_DIR/swallow-scheduler"
cp -r ~/.local/share/swallow/skill "$SKILLS_DIR/swallow-scheduler"
# 验证扫描器能看到：find "$SKILLS_DIR/swallow-scheduler" -name SKILL.md   # 应返回一行
```

swallow 升级后重跑上述命令刷新 skill 内容。详见 [install.md](install.md)。

---

## 稳定性设计（核心：成熟库兜底，不手写）

| 机制 | 实现 | 防什么 |
|---|---|---|
| 原子写 | `write-file-atomic`（data fsync + dir fsync） | state.json/.task.md 写一半被 kill 截断 |
| 进程级锁 | `proper-lockfile`（stale 60s 自动 takeover） | 多 watch / 手动与 watch 并发冲突；kill -9 残留锁 |
| 假完成三重校验 | 零改动不打勾 + 连续 3 次空转标阻塞 + 全程零 commit 不退出 | agent 空退/假完成 |
| ctx-overflow 重试 | 结构化判定（subtype+errors）+ 弃会话重开；ctx_overflow 连续 3 次达限入死信队列待拆，aborted 超时仍标阻塞 | 单会话撑爆 / worker 卡死 |
| 死信队列 + lazy 拆 | **爆了才拆**（反馈驱动，不预先递归）：tick 爆→入队 `type=task`、bootstrap 爆/截断→入队 `type=goal`，`splitTask` 拆子项回插 `.task.md` / 子 goal 独立 bootstrap；两兜底 `failed_tasks>=5`（横向拆不出累计）/ `dlq_split_count>=30`（纵向死循环）→ watch 停 | 任务太大一次装不下、子任务互相依赖无限拆 |
| ctx 健康度探针 | 上轮 token 占比超 0.7 先发 `/compact deep` 压一轮（取 `compact_metadata.post_tokens` 判定），压不下来再弃会话 | 跨 tick 累积撞墙，avoid 被动等撑爆 |
| 崩溃检测 | tick_started 与 tick_completed 配对（同 tick_id） | 发现未完成的崩溃 tick |
| events 轮转 | 超 `EVENTS_ROTATE_LINES`(5000) 行滚动归档 `events.jsonl.1`，累计计数存 `state.event_counts`（丢明细不丢计数） | append-only 长跑涨到几百 MB，读路径变慢/OOM |
| watch 卡死可观测 | runOneTask 期间节流落盘 `last_heartbeat_at`（`HEARTBEAT_FLUSH_MS`=30s），外部 agent 对比当前时间判卡死 | watch 进程没崩但卡死（代理挂/query 挂死）时无人告警 |

## 持久化文件

| 文件 | 作用 |
|---|---|
| `state.json` | 机器读恢复点（原子写）：轮次/空转/commit/终止标记/心跳/事件累计计数/**死信队列（dead_letter/failed_tasks/dlq_split_count）** |
| `events.jsonl` | append-only 审计流，`--status`/`--report` 从它读；超阈值轮转归档 `events.jsonl.1` |
| `.task.md` | 任务列表 + 勾选状态（`[ ]`/`[x]`/`[~]`）——进度真相源 |
| `.session_id` | Claude 会话 ID（单源，不进 state.json） |
| `.stop` | 停止哨兵（`--stop` 写，`--resume` 删） |
| `.tick.lock` | 进程级并发锁 |
| `night_run.log` | 人类可读文本日志 |

## 上下文管理（SDK 自带 + prompt 节流 + 爆了拆）

`autoCompactEnabled` 默认 true：上下文快满自动压成摘要，会话不中断、`session_id` 不变。真撑爆了（query 报 `error_during_execution` 含 context）→ 弃会话重开。另外 orchestrator 有主动 ctx 健康度探针：每轮结束记 `input_tokens` + `getContextUsage` 测窗口，下轮若占比超 `CTX_RECYCLE_RATIO(0.7)` 先发 `/compact deep` 压一轮（取 `compact_boundary.compact_metadata.post_tokens` 判定，压不下来再弃旧会话开新会话）。

**探针/重试都兜不住才拆**：连续 3 次 ctx_overflow 达限 → 任务入死信队列，下 tick `splitTask` 拆成可单独完成的子项回插（反馈驱动深度，不预先递归）。bootstrap 爆/截断同理（goal 入队→拆子 goal 独立 bootstrap）。这是最底层兜底，详见 [docs/dead-letter-design.md](docs/dead-letter-design.md)。

### bootstrap 知识优先 + 按需探索（防拆任务爆上下文）

旧设计让 LLM 自己 agentic 探索项目拿上下文 → 要么探索过度爆上下文（Claude Code 拆得准但爆）、要么没上下文纯猜（Hermes 拆得不准）。根因是「谁拿项目上下文」绑在 LLM 身上。

改法：**把最高价值的现成知识由 orchestrator 代码直接读出来喂进 prompt 当基线，模型拿这些做底，剩余按需自己探索——不限制死，只把它从「无脑全扫」掰向「已知为基、按需补」。** 基线优先级：

1. `CLAUDE.md`（claude code 沉淀的项目说明书，密度最高）
2. `.claude/memory/*.md` 累积记忆（架构/约定/模块边界，喂进 bootstrap 当基线）
3. 退路：都没有时代码轻量勘察目录树（限深 3 层 + manifest，跳依赖/构建产物大目录、保留隐藏文件）当探索起点，总长截断 20k

**不锁死文件工具**：CLAUDE.md/memory 当基线喂进来，剩下细节模型按需 Read/Grep——无脑全扫才爆上下文，按需探索不会。旧工程复用已有知识、不重扫；真新工程走退路给个地图当起点。Hermes 以前不准就是没上下文，现在基线喂进去了，谁拆都准。

⚠️ GLM 等代理模型上下文有限（运行时由 orchestrator 经 `getContextUsage` 实测，不写死）。worker prompt 已加节流铁律：只读与当前任务相关的文件、复用 `.claude/memory/` 已有背景、大文件 Grep 定位再按行 Read。目标项目可放 `.claudeignore` 进一步压扫描范围。orchestrator 这层另加 ctx 健康度探针：上轮 token 占比超阈值先发 `/compact deep` 压一轮，压不下来再弃旧会话开新会话。

---

## 核心机制

- 进程内 `query()`，结构化结果直出（不再 spawn `claude -p` 子进程 grep stream-json）——四个 query 调用点：`bootstrapTasks`（拆任务）/ `runOneTask`（干活，resume 同会话）/ `probeCompactDeep`（ctx 探针）/ `splitTask`（死信队列拆子项，爆才调）
- `PostToolUse` hook 实时捕获真实文件写入 → 完成判定看真实事件（不靠 `git diff` 猜）
- `abortController` + `Stop` hook 刷新心跳 → 看门狗事件驱动，不轮询
- `disallowedTools` 移除 `EnterPlanMode`/`ExitPlanMode`/`AskUserQuestion`（防卡住）
- 轮数护栏写死在脚本常量、默认 `0 = 不限`（token 不限量场景护栏纯属挡路）；行为护栏 `STALL_LIMIT=3` / `ABORT_TIMEOUT_MIN=60` / `SESSION_RETRY_LIMIT=3` / `FAILED_TASK_LIMIT=5` / `DLQ_SPLIT_LIMIT=30` 留正数防死循环；swallow.env 只管密钥/代理/模型
- 会话策略：首轮新会话、后续 resume、**永不 continue**（防旧会话污染）
- 每轮自动 commit（本地不 push），带 Co-Authored-By trailer
- 日志用本地时间（跟随系统时区 / `TZ`），不再 `toISOString()` 输出 UTC

## 验证

- e2e happy path：2 任务全跑通、2 commit、events 配对完整、state.json 正确
- **崩溃恢复**：`kill -9` 后 state.json 完好、.task.md 未误打勾、锁 stale 自动 takeover、loop_count 不丢、下次 tick 从崩溃处续跑
- flock 并发：两个 watch 同时，第二个立即 already_running
- `--stop` 哨兵：watch 收 SIGTERM 退出 + 写 .stop，`--resume` 恢复
- 假完成守卫：全 `[x]` 零 commit → 疑假完成，不设 last_termination 待人工介入
- **死信队列 + lazy 拆**（2026-07-25 全绿）：① 兜底停 watch 确定性（seed `dlq_split_count=30` → 队列清空进 failed_tasks、watch 立即 terminated、未调 splitTask）；② smoke 回归（小 goal 真跑 bootstrap→task→commit→done 未被死信改动破坏）；③ 出队链路（seed task 真跑 splitTask 拆 5 项→`insertTasksBeforeFirst` 插回→逐个 commit）。详见 [docs/dead-letter-design.md](docs/dead-letter-design.md) §13

## 文件

| 文件 | 作用 |
|---|---|
| `orchestrator.ts` | 主程序（tick + watch + state/events 持久化 + 死信队列 lazy 拆） |
| `docs/dead-letter-design.md` | 死信队列 + lazy 拆设计（已实现 + e2e 全绿） |
| `docs/observability.md` | 整个工程可观测契约（死信队列是其中 §3.8 一节） |
| `docs/hermes-guide.md` / `docs/claude-code-guide.md` | 外部 agent 接入实战（拉起 + 定时战报 + 微信推送） |
| `write-file-atomic.d.ts` | write-file-atomic v7 的 ambient 类型声明 |
| `package.json` / `tsconfig.json` | 依赖（proper-lockfile + write-file-atomic）与类型配置 |

## 依赖

| 依赖 | 用途 |
|---|---|
| `@anthropic-ai/claude-agent-sdk` | 进程内 query() + hooks |
| `proper-lockfile` | 进程级并发锁（stale takeover） |
| `write-file-atomic` | 原子写（崩溃不截断） |
| `node:util` parseArgs | CLI 解析（零依赖内置） |
| `tsx` / `typescript`（dev） | 运行/类型检查 |
