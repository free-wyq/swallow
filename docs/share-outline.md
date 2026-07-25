# Swallow：基于 Claude Agent SDK 的 24 小时无人值守开发 Orchestrator

> 分享时长 60 分钟（总分总结构），弹性预留 8 分钟。实践演示置于中篇与下篇之间。

---

## 一、开场（10 分钟）

### 1.1 标题页

**Swallow：基于 Claude Agent SDK 的 24 小时无人值守开发 Orchestrator**

- 运行时：`@anthropic-ai/claude-agent-sdk`
- 协议：Apache-2.0
- 仓库：[github.com/free-wyq/swallow](https://github.com/free-wyq/swallow)

### 1.2 问题域：AI 辅助开发的会话级天花板

当前 AI 编程助手（如 Claude Code）以交互式会话为核心工作模式，在长周期、无人值守场景下面临四项结构性限制：

| 问题 | 描述 |
|---|---|
| **上下文窗口溢出** | 单次会话上下文随轮次增长，达到上限后任务被迫中断 |
| **假完成** | 模型声明任务完成但未产生有效代码变更，缺乏可验证的完成判定 |
| **进程级失效** | 运行时进程因网络、系统等原因退出，数小时工作量丢失 |
| **无人值守中断** | 缺少自恢复机制，任务因等待用户介入而停滞 |

Swallow 项目的目标：构建一个无人值守的开发批处理引擎，使开发者设定目标后即可离线，系统自主完成拆解、执行、恢复全过程。

### 1.3 架构总览

```
┌─────────────────────────────────────┐
│        外部调用方                     │
│  (用户 / 外部 agent)                 │
│  传入目标，拉起 --watch             │
└──────────┬──────────────────────────┘
           │ --watch "构建一个 Go REST API"
           ▼
┌─────────────────────────────────────┐
│  Swallow Orchestrator               │
│  bootstrap → tick × N → done       │
│  崩溃自动续跑 · 溢出自动拆解        │
├─────────────────────────────────────┤
│  4 处 query 调用点:                  │
│  bootstrap / runOneTask /           │
│  probeCompactDeep / splitTask      │
└──────┬──────────────────────────────┘
        │ 结构化数据落地
        ▼
  ┌──────────────────────────┐
  │ 目标项目目录              │
  │  state.json   : 恢复点    │
  │  events.jsonl : 审计日志  │
  │  .task.md     : 进度源    │
  └──────────────────────────┘
```

### 1.4 核心设计理念

Swallow 架构围绕三项原则展开：

1. **任务分解**：将长周期目标拆解为幂等单步（tick），每 tick 独立可恢复
2. **可靠持久化**：所有状态与事件结构化落地，支持崩溃后精确恢复
3. **职责解耦**：Orchestrator 仅负责推进与落盘；战报由外部调用方读取结果后自行组织

后续内容依次对这三项原则进行展开。

---

## 二、主体（40 分钟）

### 2.1 幂等 Tick 与崩溃恢复机制（13 分钟）

#### 2.1.1 BootStrap → Tick 生命周期

```
用户输入: "构建一个 Go REST API"

bootstrap(query①):
  读取 CLAUDE.md + .claude/memory → 任务拆解 → 写入 .task.md
  .task.md:
    [ ] 初始化 Go module
    [ ] 实现 handler + router
    [ ] 添加测试

while(tick()):
  tick:
    读取 .task.md 首个未完成任务 → 执行 → commit
    [x] 初始化 Go module
    [ ] 实现 handler + router    ← 下一轮 tick
    [ ] 添加测试
```

关键设计决策：
- `.task.md` 为**进度真相源**，`state.json` 仅为**快速恢复点**
- 完成判定依赖 `PostToolUse` 钩子捕获引擎实际文件写入事件，非事后 `git diff` 推断
- `disallowedTools` 排除 `EnterPlanMode` / `AskUserQuestion`，防止进程因等待用户输入而阻塞

架构演进：早期版本通过 `claude -p` 子进程 + 管道 grep stream-json 采集结果；当前版本基于 SDK 的 `query()` 进程内调用，以 `await sdk.query(prompt)` 单行替换了整条管道链路。

#### 2.1.2 崩溃恢复时序

```
时间线 →
                                        💀 进程被 kill -9
tick_started(A) ─── state={loop:5, status:running} ─── 进程终止
         │
         ├── events.jsonl: 记录 tick_started(A)
         └── state.json:   {loop_count: 5, status: "running"}

60 秒后 ──────────────────────────────────────────────
新进程启动:
  Step 1 读取 state.json  → loop_count=5, status=running
  Step 2 读取 events.jsonl → 发现 tick_started(A) 无配对 tick_completed
  Step 3 判定: 第 5 轮异常终止
  Step 4 从同一任务续跑, loop_count=6
  Step 5 写入 tick_started(B) → runOneTask → 正常执行
```

三项基石技术：

| 技术 | 选型 | 解决的问题 |
|---|---|---|
| **原子写** | `write-file-atomic` v7 | 状态文件写半截被杀死不截断（临时文件 → fsync data → rename → fsync dir） |
| **进程锁** | `proper-lockfile`（stale 60s） | 防止多进程并发写入状态；`kill -9` 残留锁自动超时接管 |
| **配对检测** | events.jsonl 中 tick_started / tick_completed 配对关系 | 判定异常终止 vs 正常完成 |

#### 2.1.3 会话策略与 Query 调用点

| 调用点 | 会话策略 | 触发条件 |
|---|---|---|
| bootstrap | 新会话 | 首次任务拆解，知识优先注入 |
| runOneTask | resume（续跑同会话） | 常规任务执行 |
| probeCompactDeep | 探针会话 | 上下文占用率 > 70% |
| splitTask | 新会话 | 死信队列出队拆解 |

**设计注释：** 采用 `resume` 而非 `continue`。`continue` 在旧会话中追加消息，上下文随轮次增长无法有效回收；`resume` 保持同一会话但依赖 Auto-Compact 机制压缩历史，避免无限膨胀。

**PostToolUse 钩子工作原理：**

```
Claude 引擎执行 file_write(src/main.go)
        ↓ SDK PostToolUse 钩子捕获工具调用事件
        ↓ 宿主脚本记录文件变更
        ↓ 本轮累计变更数 > 0 → 判定有产出 → 执行 commit
```

---

### 2.2 稳定性体系（12 分钟）

#### 2.2.1 七层防线总览

Swallow 自底向上构建了七层防护，每层针对一类失效模式，上层兜底下层覆盖不了的场景：

```
  Layer 1: 原子写   (write-file-atomic)    —— 防文件截断
  Layer 2: 进程锁   (proper-lockfile)       —— 防并发冲突
  Layer 3: 假完成   (Stall Detection)       —— 防零产出完成
  Layer 4: ctx 探针 (Compact Probe)         —— 防上下文溢出
  Layer 5: 轮转     (Events Rotation)       —— 防审计日志膨胀
  Layer 6: 心跳     (Heartbeat)             —— 防无声卡死
  Layer 7: 崩溃检测 (Start/Complete Pair)   —— 防遗漏异常终止
```

#### 2.2.2 防线详述

**Layer 1 - 原子写：**
`write-file-atomic` 确保状态文件写入的崩溃安全性。过程：写入临时文件 → `fsync` 数据 → `rename` 替换原文件 → `fsync` 目录。`kill -9` 在任一时间点发生，结果均为原文件完好或新文件完整写入。

**Layer 2 - 进程锁：**
`proper-lockfile` 在 `.tick.lock` 文件上维护进程级锁。新进程发现锁文件超过 60 秒未刷新（stale threshold），自动接管。防止 cron / systemd 定时任务与手动启动的 watch 进程发生写冲突。

**Layer 3 - 假完成守卫：**
早期运行中发现模型报告"任务完成"但未产生任何代码变更的情况。守卫逻辑：

| 检测模式 | 处理方式 |
|---|---|
| 单 tick 零文件写入 | 该任务标记 `[ ]` 不变 |
| 连续 3 tick 零产出 | 标记阻塞（blocked），进入空转检测 |
| 全过程零 commit | 不写入 `last_termination` 字段，系统不会自动退出，强制人工介入 |

**Layer 4 - 上下文健康度探针：**
每轮 tick 结束后记录 `input_tokens`，调用 `getContextUsage()` 测量窗口使用率。当使用率超过 70% 时，主动发起 `/compact deep` 指令。判定依据为 `compact_metadata.post_tokens`（而非 API 返回的 `usage` 字段——compact 轮次中 `usage` 为 0，不能用于效果判定）。Compact 未能有效压缩时，弃用当前会话并建立新会话。

#### 2.2.3 可观测性体系

| 存储层 | 文件 | 用途 | 核心特性 |
|---|---|---|---|
| 恢复点 | state.json | 系统重启时的状态恢复 | 原子写、JSON 结构化、含死信队列 |
| 审计流 | events.jsonl | 事件时间线、事后审计 | append-only、超限自动轮转 |
| 人类可读日志 | night_run.log | 实时过程跟踪 | 本地时间、自然语言 |
| 可编程接口 | --status --json | 外部程序读取 | 单一 JSON 输出，跨平台零外部依赖 |

**Events 轮转策略：** 行数超过 5000 阈值后自动归档为 `events.jsonl.1`。累计事件计数持久化至 `state.event_counts` 字段，轮转丢失明细但不丢失计数。旧版 `state.json` 回退时通过扫描已有文件自动补全计数。

**Heartbeat 机制：** 每 30 秒将 `last_heartbeat_at` 写入 `state.json`。外部监控进程通过比较当前时间与心跳时间，判断 watch 进程是否处于卡死状态（如代理不可用、LLM 无响应等场景）。

---

### 2.3 实践演示（10 分钟）

#### 2.3.1 说明

演示环节展示 Swallow 的完整执行流程，包括任务拆解、状态持久化和崩溃恢复。建议会前准备好演示环境，同时录制备用视频以防现场网络波动。

#### 2.3.2 演示脚本

```bash
# Step 1: 启动执行
swallow --cwd /tmp/demo "初始化一个 Node.js CLI 工具，支持 git clone url 并统计文件数"

# Step 2: 观察执行进度
swallow --cwd /tmp/demo --status

# Step 3: 查看审计日志
tail -3 /tmp/demo/events.jsonl
# 预期输出: tick_started → file_write → tick_completed

# Step 4 (可选): 崩溃恢复演示
# 另起终端: kill -9 <pid>
# 重新查询: swallow --cwd /tmp/demo --status
# 预期: 进程自动续跑，loop_count 递增，不丢进度
```

---

### 2.4 反馈驱动拆解：死信队列机制（15 分钟）

#### 2.4.1 问题边界

当目标过于庞大（如"将单体架构重构为微服务"），bootstrap 阶段拆出的子任务可能仍然超出单次会话承载能力。传统拆解策略的局限性：

| 策略 | 局限 |
|---|---|
| **预先递归拆至最深** | 拆解深度依赖猜测，过深浪费 token，过浅仍需二次拆解 |
| **一次性全量拆解** | bootstrap 阶段自身爆上下文 |
| **固定粒度拆解** | 任务实际复杂度不均，固定粒度无法适配 |

#### 2.4.2 死信队列链路

Swallow 采取反馈驱动策略：运行时检测到溢出后，将被阻塞的内容入队，于下一 tick 集中拆解。

```
runOneTask(query) 执行中
        │
        ├── ctx_overflow 达限 3 次 → 入 dead_letter(type: task)
        │
        └── bootstrap 溢出 → 入 dead_letter(type: goal)
                    │
                    ▼
        splitTask(query④) 出队拆解
                    │
             ┌──────┴──────┐
             │              │
        type: task      type: goal
             │              │
        插回 .task.md    子 goal 独立
        (首个 [ ] 位)    bootstrap
             │              │
             ▼              ▼
          继续 tick →→→→ 继续 tick
                    │
         ┌──────────┴──────────┐
         │                     │
    failed_tasks          dlq_split_count
      >= 5 (横向累计)      >= 30 (纵向)
         │                     │
         └──→ watch 终止 ←────┘
```

两种类型死信：
- **task 型**：单个任务执行中连续 3 次 ctx_overflow，入队后 `splitTask` 拆为子任务插回 `.task.md`
- **goal 型**：bootstrap 阶段溢出或截断，入队后 `splitTask` 拆为子 goal，各子 goal 独立执行 bootstrap

两个安全阀：
- `failed_tasks >= 5`：横向不同任务各自拆解失败累计 ≥ 5 → 终止
- `dlq_split_count >= 30`：纵向同一组任务无限循环拆解 → 终止

#### 2.4.3 示例

```
原始 goal: "构建一个 Go REST API"

bootstrap 拆出 5 个 task:
  [ ] 初始化 Go module + 依赖
  [ ] 实现用户 CRUD handler
  [ ] 实现数据库层 (ctx_overflow × 3 → 入死信)
  [ ] 添加路由
  [ ] 写测试

splitTask 拆解结果:
  [ ] 定义数据库 schema + model 结构体
  [ ] 实现 repository 接口
  [ ] 实现 repository 的 SQL 实现

插回 .task.md，原 task 标记 [~] split:
  [x] 初始化 Go module + 依赖
  [x] 实现用户 CRUD handler
  [~] 实现数据库层 (已拆)
    [ ] 定义 schema + model
    [ ] 实现 repository 接口
    [ ] 实现 SQL
  [ ] 添加路由
  [ ] 写测试
```

#### 2.4.4 设计原理

| 维度 | 预先递归拆解 | 反馈驱动拆解（Swallow） |
|---|---|---|
| 触发时机 | 执行前一次完成 | 执行时按需触发 |
| 拆解深度 | 固定预设值 | 运行时实测边界 |
| Token 成本 | 可能拆出用不到的细项 | 仅处理此次溢出的边界点 |
| 工程复杂度 | 递归逻辑 + 深度判定冲突 | 单层拆解 + 计数兜底 |
| 终止保证 | 无确定性终止条件 | 双向计数确定性终止 |

**核心结论：** 任务拆解的最优粒度是运行时信息，在设计阶段无法预知。因此拆解应发生在运行时、由溢出事件驱动。这是反馈驱动拆解的本质合理性依据。

该模式具有通用性：适用于任何"边界值在执行前不可知、仅在撞到后可知"的系统设计场景。

#### 2.4.5 上下文管理递进策略

Swallow 的上下文管理采用四级递进兜底：

```
等级一: SDK Auto-Compact    ——  持续运行，被动回收
等级二: 主动 Health Probe    ——  占用率 > 70% 时主动压缩
等级三: 会话重建             ——  Compact 无效时弃用旧会话
等级四: 死信队列拆解         ——  连续溢出时结构级分解
```

前三等级为上下文层面的回收与重建；第四等级为任务结构层面的分解。实践中，超过 85% 的溢出场景在等级一即可解决，到达等级四的比例通常低于 5%。

---

## 三、总结（8 分钟）

### 3.1 核心要点回顾

**要点一：长周期任务应分解为幂等短步执行**

幂等 tick 架构 + 崩溃恢复 + 原子写持久化，使系统在进程级失效后能够精确恢复，不丢失进度、不重复执行。

**要点二：稳定性依赖系统性防线而非单一措施**

从原子写到崩溃检测的七层防护，每层应对一类失效模式。防线随实际运行经验持续补充。

**要点三：拆解粒度不需预先确定，应由运行时反馈驱动**

死信队列机制将拆解时机从设计阶段推迟到溢出发生时，以实测边界而非预设深度决定拆解粒度。

### 3.2 适用场景与限制

| 场景 | 适用性评估 |
|---|---|
| 技术债批量修复（lint / 类型 / 重构） | **推荐**：批处理模式，无需逐行介入 |
| 方案已知的功能开发 | **推荐**：开发者确定方案，AI 执行编码 |
| 24 小时无人值守构建 | **推荐**：睡前启动，醒来验证 |
| 探索性设计 | **不推荐**：需要开发者持续决策与反馈 |
| 高风险重构 | **谨慎使用**：建议先在非关键分支验证 |

建议：使用前确保项目中存在 `CLAUDE.md` 和 `.claude/memory/` 知识沉淀，这两者直接影响任务拆解的准确性和效率。

### 3.3 预设问答

#### Q1: Swallow 与 Claude Code 的关系是什么？

两者定位不同。Claude Code 是交互式开发助手，面向人在回路的探索与编码。Swallow 是无人值守的批处理引擎，面向已知目标的长周期自主执行。两者互补：探索阶段使用 Claude Code，方案确定后使用 Swallow 执行。

#### Q2: 如何控制成本？

实际运行中时间是主要瓶颈，token 成本相对次要。真正需要避免的是在无法拆解的任务上持续消耗资源——死信队列的计数兜底（failed_tasks / dlq_split_count）是比 token 硬限制更有效的成本控制手段。

#### Q3: 如何获取运行报告？

Orchestrator 不主动发送任何消息。外部程序通过 `--status --json` 读取结构化结果，自行决定通知方式（企业微信、钉钉、飞书、邮件等）。职责解耦：推进进程的存活状态不影响已落盘结果的读取与分发。

#### Q4: 是否支持非 Claude 模型？

当前实现基于 Claude Agent SDK，底层引擎由 SDK 的 `optionalDependencies` 按平台打包分发。API 层可通过 `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 切换，但上下文管理逻辑（如 `/compact` 指令）需要目标模型提供等效能力。

#### Q5: 生产就绪度？

项目已通过 e2e 测试（含崩溃恢复、死信队列拆解、并发锁争用等场景），协议为 Apache-2.0。核心依赖 `write-file-atomic` 和 `proper-lockfile` 均为周下载量千万级的稳定库。建议在实际使用前，先在非关键分支完成若干完整轮次的验证运行。

---

## 附录：时间线总表

| 段落 | 模块 | 内容 | 幻灯片 # | 时长 |
|---|---|---|---|---|
| 开场 | 问题域 + 架构总览 | 痛点分析 / 架构图 / 三项设计原则 | 1–4 | 10min |
| 主体·上 | 幂等 Tick 与崩溃恢复 | 生命周期 / 崩溃时序 / Query 调用点 / 会话策略 | 5–7 | 13min |
| 主体·中 | 稳定性体系 | 七层防线详解 / 可观测性 / Events 轮转 / Heartbeat | 8–10 | 12min |
| | 实践演示 | 执行流程 / 状态查询 / 审计日志 / 崩溃恢复 | 演示 | 10min |
| 主体·下 | 反馈驱动拆解 | 死信队列 / 链路流程 / 示例 / 原理对比 / 递进策略 | 11–15 | 15min |
| 总结 | 回顾 + 边界 + Q&A | 三要点回顾 / 适用场景 / 5 个预设问答 | 16–18 | 8min（→68min） |

**调整策略（超时时可启用的备选措施）：**
- 稳定性防线各层缩减为一句话概览（节省 2–3 分钟）
- 会话策略中省略 probeCompactDeep 详细判定逻辑（节省 1 分钟）
- 崩溃恢复演示改为播放录制视频（节省 2 分钟，同时降低接口波动风险）

---

*版本：2026-07-25*
*项目：[github.com/free-wyq/swallow](https://github.com/free-wyq/swallow)*
