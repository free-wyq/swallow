---
name: swallow-scheduler
description: "用于要持续干很久、人不想盯着的活——如「帮我把这个项目从零搭起来」「自动把缺陷表里失败的项全修了」「跑一晚上把这个功能做完」「把整个项目从 JS 迁到 TS」。swallow 自主拆任务、写代码、跑测试、提交，24 小时无人值守。"
---

# Swallow Scheduler

swallow 自驱推进开发任务、把结果结构化落盘，**不发战报、不推送**；外部 agent（你）定时读结果、组织战报、推送到你的频道。

## 适用场景（先判断，避免重复折腾）

- **skill 已注册**（`run.sh` 在你的 skills 目录里）→ 直接跳「用法」节跑，不询问。
- **没注册 / 首次用** → 按 [install.md](../install.md) 走（克隆代码 → `cp -r skill` 注册进你的 skills 目录 → 配密钥），装好回来。本文只讲怎么用、怎么看状态、怎么发战报。

## 铁律（外部 agent 必须遵守）

- 只把任务目标（goal）交给脚本，脚本自己拆任务。
- 禁止编辑 `.task.md`。
- 禁止自己拆任务——无论从哪里抠任务都不行。

## 用法

`run.sh` 是本 skill 的**唯一执行入口**——注册即用，直接调它（自定位 + 透传所有参数给 `orchestrator.ts`）。推进靠 `--watch` 长进程，崩了重启续跑（从 `state.json` 恢复点继续，不丢进度、不重复打勾）。

```bash
# <skill目录> = 你注册本 skill 的目录（如 ~/.claude/skills/swallow-scheduler）
bash <skill目录>/run.sh --cwd <项目> "目标"            # 拉起推进（--watch 自驱）
bash <skill目录>/run.sh --cwd <项目> --status          # 实时状态（人看）
bash <skill目录>/run.sh --cwd <项目> --status --json   # 结构化 JSON（程序读，跨平台零依赖）
bash <skill目录>/run.sh --cwd <项目> --report          # 运行报告
bash <skill目录>/run.sh --cwd <项目> --stop            # 临时停（写 .stop 哨兵 + 杀 watch）
bash <skill目录>/run.sh --cwd <项目> --resume          # 恢复运行（删 .stop 哨兵 + 若 watch 没在跑则从 state.json 拉起）
```

> `run.sh` 靠 `BASH_SOURCE` 自定位，无论从哪调都能找到同目录的 `orchestrator.ts` 和 `package.json`，不必 cd 进 skill 目录。

⚠️ 目标项目绝不能是 swallow 仓库自身——会污染 git 历史。
⚠️ 停 swallow 用 `--stop`，别 `kill -9` watch 父进程——`--stop` 发 SIGTERM 会联动终止 claude 子进程后干净退出；`kill -9` 会让 claude 子进程变孤儿继续烧 token。`--resume` 恢复运行：删 `.stop` 哨兵，watch 没在跑时自动从 `state.json` 拉起（goal 从 state.json 读，无需再传）。
⚠️ `run.sh` 首次跑自动拉 ~530MB 依赖到 `~/.local/share/swallow/deps`（共享缓存，幂等跳过）；缺 Node 18+ / 缺密钥会提前提示，不会撞到莫名错。

## 结构化结果（你发战报的数据源）

三文件各司其职：`state.json`（恢复点快照，机器读）+ `events.jsonl`（append-only 审计流）+ `.task.md`（任务列表 + 勾选状态 `[ ]`/`[x]`/`[~]`，进度真相源）。

字段语义、事件类型清单、判崩溃规则、`--status --json` 汇总结构（含 `dead_letter` 块字段）——见 [docs/observability.md](../docs/observability.md) §3（按维度详述）+ §4（消费出口）。

**速查：判 watch 卡死**（发战报最常查）——`last_heartbeat_at` 比当前时间老超过 60 分钟且 `status=running` → watch 可能卡死（进程没崩但 query 挂死），需人工介入或重启。`last_tick_at` tick 期间冻结，不能单独判卡死。

## 发战报

起定时任务读上述文件，按你的判断组织战报。推荐用 `bash "$RUN" --cwd <项目> --status --json` —— 跨平台零依赖、把 state.json + .task.md + events 末尾 + watch 进程汇总成单一 JSON（字段结构见 [observability.md §4.2](../docs/observability.md)）。⚠️ 解析数字字段时若跑在带 `FORCE_COLOR` 的环境，用 `env -u FORCE_COLOR` 或读 `JSON.parse` 后取值，别比较原始 stdout（node 会给数字加 ANSI 色污染断言）。参考格式（非强制）：

```
📊 swallow 战报 20:38

✅ 任务 3：数据库连接池配置 — 已完成
🔄 第 2 轮，剩余 7/8
📋 进行中：任务 4 gateway 规则编译失败时跳过
🔧 当前操作：正在改 src/server.go
⏱ 心跳：20:24:11（启动 20:07:54，已运行 30 分钟）
📊 进度：1/8
🧹 上下文压缩（/compact deep 压缩成功）：81663 → 2611 tokens（压掉 79K，压缩至 3.2%·约 1/31）
```

**死信/失败行（条件显示，常态空不刷屏）**——死信队列或真失败册非空时才加这两行；都空就别发：

```
♻️ 死信拆分中：2 项待拆（已拆 5/30 次，接近上限将兜底停）
🚫 真失败：1 项拆不动需人工核实（累计 1/5）
```

**兜底停告警（`last_termination.reason=dead_letter_exhausted` 时置顶）**——watch 已停，需人工介入，别当正常进度报：

```
🛑 死信兜底停：横向 5 项拆不出 / 纵向拆 30 次仍在拆 → 需人工拆解或换更小 goal
```

字段映射：轮数→`loop_count`、剩余/进度→`.task.md`、心跳→`last_heartbeat_at`、空转→`stall_count`、压缩→`compact_probe_ok` 事件、**死信拆分→`dead_letter.queue_len`/`dlq_split_count`/`dlq_split_limit`、真失败→`dead_letter.failed_count`/`failed_task_limit`、兜底停→`last_termination.reason=dead_letter_exhausted`**。`当前操作`、`启动时间`等细粒度项 swallow 无专字段——从 events 末尾事件 / night_run.log 自行推断。

**压缩行数据源（`compact_probe_ok` 事件）**：`pre`（压缩前 token）/ `post`（压缩后 token）同源同量纲成对可比，直接算 `freed = pre - post`（压缩量）、`compress_ratio = post / pre`（压缩比）。⚠️ 这俩是**单次压缩的成对前后值**，别和 `/compact` 命令界面显示的「会话累计流经 1.44M → 当前 1 万」混了——后者 `before` 是会话累计（17 轮累加、量纲不同、不可比压缩比），swallow 探针的 `pre` 是单轮值（≤模型窗口）。两者别放一起比。

接入实战（任务执行 + 定时战报 + 微信推送）：
- [Hermes 实战](../docs/hermes-guide.md)
- [Claude Code 实战](../docs/claude-code-guide.md)

## 已知行为

- **bootstrap 慢属正常**：目标里若含 SPA 链接（腾讯文档等），WebFetch 拿不到表格数据，worker 会写 Playwright 脚本爬取——可能耗时 10+ 分钟但最终能成。别手动预写 `.task.md`（自己拆的任务可能不符合 goal 结构）。
- **项目已 done 后跑新缺陷**：直接重启会被 `state.json` 的 `last_termination={reason:"done"}` 挡掉（tick 直接 already_terminated 跳过）。要继续跑，清掉 `state.json` 的 `last_termination` 字段（置 `null`）或换新 goal 触发重新 bootstrap。`dead_letter_exhausted` 同理（兜底停了 watch，清该字段或换 goal 才能重启）。
- **撞 blocked_suspect 先看探针**：`status=blocked_suspect`（疑假完成）或 `ctx_overflow_retry` 频繁时，查 events.jsonl 有没有 `compact_probe_ok`——有探针压成功说明 ctx 在自我回收；没有就是真撞墙，多半是目标项目上下文太大，可在项目根放 `.claudeignore` 压扫描范围。
- **死信队列兜底停**：`last_termination=dead_letter_exhausted` 说明任务大到连拆都拆不动。查 events 的 `task_split` 链看是哪个 task 反复爆，人工拆解或换更小 goal。详见 [docs/dead-letter-design.md](../docs/dead-letter-design.md) §8。
- **死信队列在拆分中**：`--status` 见 `dead_letter.queue_len > 0` 属正常（正在 `splitTask` 拆子项回插）。关注 `dlq_split_count` 接近 30 或 `failed_count` 涨——接近上限就是兜底将至的前兆，判定见 [observability.md](../docs/observability.md) §5。

## 可观测性

swallow 落盘的是**结论**(轮次/进度/健康/卡死),子进程跟模型的对话内容、工具调用细节**不进 swallow**(喂进 events 会瞬间撑爆——单 session 转录就几 MB)。结论够发战报、判异常;真要深挖某轮 Claude 干了啥,去引擎的 session 转录查。

**深挖子进程细节 3 步:**

1. **拿 session_id** —— 从 `night_run.log` 的 `🔗 新会话已建立: <session-id>` 行,或 events.jsonl 的 `session_created` 事件 data.session_id。⚠️ **仅 tick 路径有**;bootstrap/splitTask 路径不落 session_id,这两路想查只能按崩溃时间戳反查 projects 目录(见下)。
2. **找转录文件** —— 引擎把每个 session 存成 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`。encoded 规则=cwd 绝对路径的 `/` 换成 `-`(如 `/home/wyq/work/AgenticX/enterprise` → `-home-wyq-work-AgenticX-enterprise`)。encoded 由引擎做,swallow 不参与。
3. **读转录** —— 每行一个 JSON 事件:`assistant`(消息+thinking)/ `tool_use`(干了啥,带工具名+参数)/ `tool_result`(工具返回)/ `user`(含 last-prompt 即喂给模型的 prompt)。`jq`/`grep` 解析。usage.input_tokens 在 assistant 行的 message.usage 里。

**两个边界(诚实):**
- **撞 ctx 墙的轮(如 `400 input longer than context length`)被模型拒、无 assistant 响应** → 转录里没那轮的 usage,撞墙的精确 token 数看 `night_run.log` 的 `💥 orchestrator 崩溃` 行。
- **bootstrap/splitTask 崩溃轮没 session_id 落盘** → 按崩溃时间戳去 `~/.claude/projects/<encoded-cwd>/` 找时间最近的 `.jsonl`(`ls -lat *.jsonl | head`)。

完整信号体系(三层可观测面 + 8 类信号维度 + 外部 agent 监控契约)见 [docs/observability.md](../docs/observability.md)。
