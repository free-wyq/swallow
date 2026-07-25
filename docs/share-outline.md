# Swallow 分享大纲（1h · 总分总）

> 24h 无人值守开发 Orchestrator —— 给一个目标，睡一觉，看 commit
>
> 建议时长 60min，弹性预留 8min。Demo 放在中篇之后、下篇之前。

---

## 🎯 总（10min）—— 让 Claude 替你奋斗一晚上

### Slide 01：标题页（1min）

> **Swallow —— 24h 无人值守开发 Orchestrator**
>
> 给一个目标，睡一觉，看 commit。
>
> 基于 `@anthropic-ai/claude-agent-sdk`，Apache-2.0 开源
> GitHub: [github.com/free-wyq/swallow](https://github.com/free-wyq/swallow)

### Slide 02：痛点故事（3min）

三个场景引发共鸣：

| 场景 | 问题 |
|---|---|
| Claude Code 跑中型重构 | 上下文撑爆，前面白等 |
| 助手说「做完了」 | git diff 零改动——假完成 |
| 放服务器上跑 | 半小时卡住，白白停一整夜 |

**演讲者口吻：** "这三个问题我都遇到了，而且我相信大部分深度用 AI 写代码的人都遇到过。Swallow 就是为了解决这些 '一次对话搞不定' 的问题而做的。"

### Slide 03：Swallow 全貌 + 项目历史（3min）

```
┌─────────────────────────────────────┐
│        外部 agent / 用户             │
│  给一个目标, 拉起 --watch           │
└──────────┬──────────────────────────┘
           │ "构建一个 Go REST API"
           ▼
┌─────────────────────────────────────┐
│  swallow 脚本                        │
│  bootstrap → tick × N → done       │
│  崩了续跑 · 爆了自动拆              │
├─────────────────────────────────────┤
│  4 个 query 调用点:                  │
│  bootstrap / runOneTask /           │
│  probeCompactDeep / splitTask      │
└──────┬──────────────────────────────┘
        │ write state.json / events / .task.md
        ▼
  ┌──────────────────┐
  │ 目标项目目录       │
  │  state.json       │ ← 恢复点
  │  events.jsonl     │ ← 审计日志
  │  .task.md         │ ← 进度真相源
  └──────────────────┘
        │ 外部 agent 定时读
        ▼
  ┌──────────────┐
  │ 战报(企微等)  │
  └──────────────┘
```

三个设计原则一句话：
1. **推进** —— orchestrator 自驱跑到完成
2. **落盘** —— 状态 / 事件 / 任务进度结构化落地
3. **解耦** —— orchestrator 不发战报，战报由外部 agent 读结果自行发

### Slide 04：三句话揭晓核心设计思路（3min）

> **① 长跑拆成短跑** —— 幂等 tick，每 tick 只做一个任务
> **② 稳定靠工程不靠运气** —— 7 道防线层层兜底
> **③ 不提前猜，爆了再拆** —— 反馈驱动拆解的死信队列

"接下来 40 分钟，我按这三句话展开。"

---

## 🔍 分（40min）

---

### 上篇：幂等 tick 与崩溃恢复（13min）

#### Slide 05：bootstrap → tick 的生命周期（4min）

```
用户输入: "构建一个 Go REST API"

bootstrap(query①):
  读 CLAUDE.md + memory → 拆任务 → 写 .task.md
  .task.md:
    [ ] 初始化 Go module
    [ ] 实现 handler + router
    [ ] 添加测试

while(tick()):
  tick:
    读 .task.md 第一个 [ ] → 跑 → commit
    [x] 初始化 Go module
    [ ] 实现 handler + router    ← 下一轮 tick 继续
    [ ] 添加测试
```

关键设计决定：
- `.task.md` 是**进度真相源**，state.json 只是**恢复点**
- 事件驱动完成判定（`PostToolUse` 钩子捕获真实文件写入），不靠 `git diff` 猜
- `disallowedTools` 移除 `EnterPlanMode` / `AskUserQuestion` —— 无人值守不能卡住等人

**对比演进：** spawn `claude -p` 子进程管道 grep stream-json → 改成 SDK 的 `query()` 进程内调用，一句 `await sdk.query()` 解决问题。

#### Slide 06：崩溃恢复——最硬核的工程（5min）

```
时间线 →
                                        💀 kill -9
tick_started(A) ─── state={loop:5, status:running} ─── 进程消失
         │
         ├── events.jsonl: tick_started(A) 写了
         └── state.json: {loop_count: 5, status: "running"}

60s 后 ────────────────────────────────────────────────
新进程启动:
  Step 1: 读 state.json → loop_count=5, status=running
  Step 2: 读 events.jsonl → tick_started(A) 无配对 tick_completed
  Step 3: 判定: 第 5 轮崩了
  Step 4: 续跑同一任务, loop_count=6
  Step 5: tick_started(B) → runOneTask → 正常执行
```

三个关键技术点：
1. **原子写** —— `write-file-atomic`，data fsync + dir fsync，截断不损原文件
2. **stale lock** —— `proper-lockfile` 60s 自动超时，kill -9 残留锁不永久阻塞
3. **配对检测** —— 同一 tick_id 有 start 无 complete = 崩溃

| | 普通 fs.writeFile | write-file-atomic |
|---|---|---|
| 写一半被 kill | 残留截断文件 | 临时文件不 rename，原文件完好 |
| 数据到磁盘 | 不保证 | data fsync + dir fsync |

#### Slide 07：会话策略 + Query 调用点（4min）

```
bootstrap         → 新会话     ← 拆任务(知识优先)
runOneTask        → resume    ← 同会话续跑, 不 continue
probeCompactDeep  → 探针      ← ctx 占比 > 0.7 触发
splitTask         → 新会话     ← 死信拆解
```

**为什么 resume 而不是 continue？**
- `continue`：在旧会话里追加——累积上下文污染，越跑越慢
- `resume`：保持同一会话——上下文通过 compact 回收，不会无限膨胀

**PostToolUse 钩子：**

```
Claude 引擎写了 src/main.go
        ↓ PostToolUse 钩子捕获
        ↓ 记录文件写入事件
        ↓ 写入事件数 > 0 → 这 tick 有产出 → commit
```

这不是猜测——SDK hook 机制，引擎每做一个工具调用都回调通知宿主脚本。

---

### 中篇：稳定不是靠运气，是靠工程（12min）

#### Slide 08：七道防线总览（3min）

从外到内七层：

```
        ① 原子写 (write-file-atomic)
          ② 进程锁 (proper-lockfile)
            ③ 假完成守卫 (stall detection)
              ④ ctx 健康度探针 (probeCompactDeep)
                ⑤ events 轮转 (rotate)
                  ⑥ 心跳可观测 (heartbeat)
                    ⑦ 崩溃检测 (start/complete pair)
```

每一道防线都是在前一道兜不住时出手的。从上到下：越往外越通用，越往里越专。

#### Slide 09：防线详解（5min）

**① 原子写**
临文件 → fsync data → rename → fsync dir。`write-file-atomic` v7，周下载量千万级。

**② 进程锁**
防手误同时跑两个 watch。`proper-lockfile` lock 文件 + 60s stale 超时。

**③ 假完成守卫（最有故事性）**

> "第一次跑了一整夜，早上起来看到 'All tasks completed!'——git log 一看，0 个 commit。"
>
> 假完成的三种表现：
> - Claude 说做完了但代码零改动 → 零改动不打勾
> - Tick 跑完了只有 git message 没改文件 → 连续 3 次空转标阻塞
> - 全程 0 commit → 不设 last_termination，必须人工介入

**④ ctx 健康度探针**
每轮结束记 `input_tokens` + `getContextUsage` 测窗口。超 70% 先发 `/compact deep`（取 `compact_metadata.post_tokens` 判定），压不下来再弃会话。

#### Slide 10：可观测性设计（4min）

| 层次 | 文件 | 用途 | 特点 |
|---|---|---|---|
| 恢复点 | state.json | 机器读，快速重启 | 原子写，JSON 结构，含死信队列 |
| 审计流 | events.jsonl | 时间线，事后排查 | append-only，超阈值轮转 |
| 人类可读 | night_run.log | 实时跟踪 | 本地时间，自然语言 |
| 结构化查询 | --status --json | 程序读，跨平台 | 单 JSON，不依赖 jq |

**Events 轮转：** 5000 行阈值，超了自动归档 `events.jsonl.1`。累计计数存 `state.event_counts`，丢明细不丢计数。旧 state 回退时扫文件补计数（向前兼容）。

**心跳机制：** 每 30s 落盘 `last_heartbeat_at`，外部 agent 对比当前时间判定 watch 是否卡死。

---

### 实战 Demo（10min）

**位置：** 中篇之后、下篇之前。听众此时已有架构和稳定性认知，看 demo 有基础。

**步骤：**

```bash
# 1. 安装（提前准备好环境）
swallow --cwd /tmp/demo "初始化一个 Node.js CLI 工具，支持 git clone url 并统计文件数"

# 2. 跟踪第一轮
swallow --cwd /tmp/demo --status
# 看 state.json 的 loop_count, status, last_task

# 3. 看审计流
tail -3 /tmp/demo/events.jsonl
# 看到 tick_started → file_write → tick_completed

# 4. （可选，显功力）kill 演示
# kill -9 <pid> → 再跑 --status 看它续跑
```

**备选方案：** 提前录 3min demo 视频备播，防现场网络/API 波动。

---

### 下篇：反馈驱动拆解（15min）

#### Slide 11：死信队列——最核心的创新设计（4min）

**问题：** 任务大到一锅装不下怎么办？"把这个 monolith 重构为微服务"——1000 个文件、跨模块依赖。

**传统做法的问题：**
- 预先递归拆到最深 → 深度猜多少？子项能独立完成吗？
- 一次拆完 → bootstrap 自己先撑爆
- 固定粒度 → 有的子任务 200 行就做完，有的 2000 行还是中间产物

> **Swallow 的答案：爆了才拆。**

#### Slide 12：死信队列完整流程（4min）

```
runOneTask(query) 执行中
        │
        ├── ctx_overflow 连续 3 次 → 入 dead_letter(type: task)
        │
        └── bootstrap 爆/截断 → 入 dead_letter(type: goal)
                    │
                    ▼
        splitTask(query④) 出队 拆解
                    │
             ┌──────┴──────┐
             │              │
        type: task      type: goal
             │              │
       插回 .task.md    子 goal 独立
        第一个 [ ]       bootstrap
             │              │
             ▼              ▼
         继续 tick → → → → 继续 tick
                    │
             ┌──────┴──────┐
             │              │
      failed_tasks     dlq_split_count
         >= 5             >= 30
             │              │
             └──→ 停 watch ←─┘
```

入队条件：`ctx_overflow` 连续 3 次达限，或 bootstrap 爆/截断。出队拆解用独立 query，不看全量代码。两兜底防死循环。

#### Slide 13：代码级示例（3min）

```
原始 goal: "构建一个 Go REST API"

bootstrap 拆出 5 个 task:
  [ ] 初始化 Go module + 依赖
  [ ] 实现用户 CRUD handler
  [ ] 实现数据库层 (撑爆了！ctx_overflow × 3)
  [ ] 添加路由
  [ ] 写测试

# 第三个 task "实现数据库层" 入队 dead_letter
# splitTask 拆出：
  [ ] 定义数据库 schema + model 结构体
  [ ] 实现 repository 接口
  [ ] 实现 repository 的 SQL 实现

# 插回 .task.md，原 task 标记 [~] split：
  [x] 初始化 Go module + 依赖
  [x] 实现用户 CRUD handler
  [~] 实现数据库层 (已拆)
    [ ] 定义 schema + model
    [ ] 实现 repository 接口
    [ ] 实现 SQL
  [ ] 添加路由
  [ ] 写测试
```

#### Slide 14：为什么「反馈驱动」比「预先递归」好（4min）

| 维度 | 预先递归 | 反馈驱动（Swallow） |
|---|---|---|
| 拆解时机 | bootstrap 时一次拆完 | 爆了才拆 |
| 拆解深度 | 固定（猜的） | 实际 runtime 边界 |
| Token 利用率 | 可能拆出永远用不到的子项 | 只拆这次撑爆的这一个 |
| 复杂度 | 递归逻辑复杂、深度判断冲突 | 单层拆解，简单鲁棒 |
| 兜底 | 深了浪费、浅了没用 | 两层兜底计数确定性停 |

**核心洞察：**

> "任务拆解的本质问题不是'怎么拆得细'，而是'拆到什么粒度刚好不会撑爆上下文'。这个粒度是 runtime 信息，不是设计阶段可以预知的。所以拆解应该发生在运行时、由反馈驱动——这就是 Swallow 死信队列的设计逻辑。"

**可迁移模式：** 反馈驱动拆解不限于 AI agent 任务拆解。任何"你不知道边界在哪直到你撞到它"的场景都可以用。

#### Slide 15：上下文管理递进策略——四层兜底（快速过）

```
越早触发越好         越晚触发越重
① SDK 自动 compact   → 无感知，一直在做
② 主动 ctx 探针      → 占比 > 0.7 触发
③ 弃会话开新会话     → compact 压不下来
④ 死信队列拆任务     → 连续 3 次撑爆
```

前三层是上下文回收，第四层是结构级兜底。85% 的情况第一层就消化了，不到 5% 会走到第四层。

---

## 🎯 总（8min）

### Slide 16：三句话回顾（3min）

对应开场三句话，现在每句都有了实战支撑：

> **① 长跑拆成短跑**
> 幂等 tick + 崩溃恢复 + 原子写。不只讲了概念——刚才 Demo 看到了崩了怎么自动续跑。
>
> **② 稳定是一层层防出来的**
> 原子写 → 进程锁 → 假完成守卫 → ctx 探针 → events 轮转 → 心跳 → 崩溃检测。七道防线，每一道都是踩坑换来的经验。
>
> **③ 不提前猜，爆了再拆**
> 死信队列——反馈驱动的拆解策略。拆解深度是 runtime 信息，不在设计阶段预知。

### Slide 17：适用场景和边界（2min）

| 场景 | 推荐 | 不推荐 |
|---|---|---|
| 遗留代码批量修 lint / 自动修复 | 一次跑完不盯着 | 逐行 review 才放心 |
| 方案已知的新功能开发 | 你定好方案让 AI 码 | 探索性设计（需要你介入） |
| 24h 无人值守大工程 | 睡前跑、醒来验证 | 单行修复（手动更快） |
| 重构已知结构的 target | 完美 | 不确定怎么改的（担心意外） |

**给团队的建议：** 跑起来前先写 CLAUDE.md 和 .claude/memory——这决定了拆出来的任务有多准。

### Slide 18：Q&A 预备（3min，弹性扩展到 10min）

**Q1: 和直接运行 Claude Code 有什么区别？**
> 定位不同。Claude Code 是交互式开发助手——你盯着它，给它反馈。Swallow 是无人值守的批处理引擎——给个目标，它自驱跑完，崩了自己续。两者互补：你用 Claude Code 做探索性工作，用 Swallow 做已知方案的生产。

**Q2: token 成本控制？**
> 实际场景下时间才是瓶颈，token 成本反而是次要的。真正需要控制的是"别在注定拆不出的任务上浪费钱"——死信队列的计数兜底比 token 限制更重要。

**Q3: 战报怎么发？**
> Swallow 根本不发战报。它只做：推进 + 落盘。外部 agent 通过 `--status --json` 读结构化结果。解耦设计：watch 挂了不影响发战报，外部 agent 挂了不影响 watch 推进。

**Q4: 能和其他 LLM 一起用吗？**
> 当前基于 Claude Agent SDK，底层引擎是 SDK 自带打包的 claude 二进制。理论上其他 LLM 可以通过 API 替换（改 `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL`），但上下文管理逻辑需要针对不同模型调整。

**Q5: 生产环境用了吗？**
> 项目本身是 Apache-2.0 开源，e2e 全绿通过。核心机制依赖的 `write-file-atomic` 和 `proper-lockfile` 都是周下载量千万级的成熟库。建议先在非关键分支试用。

---

## 📋 时间线总表

| 时段 | 模块 | 内容 | 幻灯片 | 时间 |
|---|---|---|---|---|
| **总** | 开场 | 痛点故事 + 全貌 + 三句话 | 01-04 | 10min |
| **分·上** | 幂等 tick 与崩溃恢复 | 生命周期 / 崩溃时序 / 会话策略 + query 调用点 | 05-07 | 13min |
| **分·中** | 七道防线 + 可观测性 | 防线总览 / 逐道详解 / events 轮转 / 心跳 | 08-10 | 12min |
| | **Demo** | 安装 → 跑 → 看状态 →（可选）kill 演示 | 实战 | 10min |
| **分·下** | 死信队列 + 反馈驱动拆解 | 问题 / 流程 / 代码示例 / 对比 / 四层兜底一览 | 11-15 | 15min |
| **总** | 收尾 | 三句话回顾 / 场景边界 / Q&A | 16-18 | 8min（至 68min） |

浮动时间给 Q&A 延展或前面环节跑慢。超时可砍：
- 防线每道只讲一句话不全展开（省 2-3min）
- 会话策略删掉探针细节（省 1min）
- Demo 的 kill 演示提前录视频备份（省 2min，更稳定）

---

*生成日期：2026-07-25*
*基于 [swallow](https://github.com/free-wyq/swallow) 项目*
