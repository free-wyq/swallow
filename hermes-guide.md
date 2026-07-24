# Hermes 最佳配置实战：任务执行 + 定时任务 + 微信推送

把 loop orchestrator 接进 Hermes，实现：loop --watch 自驱跑开发任务 → Hermes 守护（崩了自动拉起）→ Hermes 定时读结果 → 企业微信群收战报。

三个角色互不依赖：watch 推进 / Hermes 守护+定时读 / 企业微信收战报。任一方挂了不影响其它。

## 前置

- loop 已装：`curl -fsSL https://raw.githubusercontent.com/free-wyq/loop/main/install.sh | bash`
- `~/.config/loop.env` 配好密钥/代理/模型（`chmod 600`）
- Hermes 已装、企业微信已配（`hermes setup` 里配企业微信群机器人 webhook）

下文 `<项目>` 一律替换成你的项目绝对路径，如 `/home/you/work/myapp`。

## 1. 任务执行：拉起 loop --watch + Hermes 守护

### 1.1 首次拉起（带目标）

```bash
loop --cwd <项目> "把缺陷表里失败的项全修了" 2>&1 | tee <项目>/night_run.log
```

`--watch` 自驱：bootstrap 拆任务 → `while(tick)` 推进 → 每轮 commit。崩了能从 `state.json` 续跑（不丢进度），但**不会自己重启进程**——靠下面的守护。

> ⚠️ 目标项目绝不能是 loop 仓库自身，会污染 git 历史。

### 1.2 Hermes 守护：崩了自动拉起

写个看门狗脚本（Hermes `--no-agent --script` 模式：脚本 stdout 直接投递，空=静默，零 token 成本）：

```bash
# ~/.hermes/scripts/loop-watchdog.sh
#!/usr/bin/env bash
set -euo pipefail
PROJECT="<项目>"                     # ← 改成你的项目绝对路径
cd "$PROJECT" || exit 0

[ -f .stop ] && exit 0                                        # 用户主动停，别拉起
grep -q '"last_termination"' state.json 2>/dev/null && exit 0  # 已完成，别拉起
grep -q '"blocked_suspect"' state.json 2>/dev/null && exit 0   # 疑假完成待人工，别拉起
[ -f .pid ] && kill -0 "$(cat .pid)" 2>/dev/null && exit 0     # 还活着，别拉起

# 挂了 → 续跑拉起（无 goal → loop 从 state.json 读 goal，不重 bootstrap）
nohup loop --cwd "$PROJECT" >> night_run.log 2>&1 &
echo "$!" > .pid
echo "🔄 loop --watch 挂了，已重启（PID $!）"
```

注册成 Hermes 定时任务（每 2 分钟查一次，挂了才推微信）：

```bash
hermes cron create "every 2m" \
  --name loop-watchdog \
  --no-agent \
  --script loop-watchdog.sh \
  --deliver wecom
```

空 stdout = 一切正常不打扰；重启才推一条企业微信。watch 崩了 → 最多 2 分钟内自动拉起续跑。

## 2. 定时任务：读结果 + 推战报

loop 把结果结构化落盘（`state.json` / `events.jsonl` / `.task.md`），Hermes 定时读这些自行组织战报。loop 本身不掺和战报生成。

### 2.1 每 5 分钟状态推送

```bash
hermes cron create "every 5m" \
  --name loop-status-push \
  --deliver wecom \
  --workdir <项目> \
  "读取 night_run.log 最后 15 行、loop --cwd <项目> --status 输出、.task.md 任务列表，按以下格式汇总成一条中文消息：

📊 loop 战报 [当前时间]

✅ [已完成的任务，带简述，没有则写「暂无」]
🔄 第 N 轮，剩余 X/Y
📋 进行中：[当前任务简述]
🔧 当前操作：[从日志提取最新动作，如「正在改 xxx」「跑 typecheck」「commit 中」]
⏱ 心跳：[最后心跳时间]（启动 [启动时间]，已运行 [时长]）
📊 进度：[已完成数]/[总数]
🧹 [上下文压缩状态，有 /compact deep 则显示「上下文 XM→YK（/compact deep 压缩成功）」，无则不显示此行]
⚠️ [异常标注：空转/阻塞/报错/崩溃才显示，无异常则不显示此行]

要求：
- loop 命令已配好 ~/.config/loop.env，直接跑 loop --cwd <项目> --status 即可，不要 export 环境变量、不要 source ~/.bashrc
- 启动时间从 night_run.log 第一行的 orchestrator 启动时间提取
- 心跳时间从 state.json 的 last_heartbeat_at 字段读
- 已完成的任务统一用「已完成」，不用「已修复」
- 简洁，一目了然"
```

### 2.2 每日晨报

```bash
hermes cron create "0 9 * * *" \
  --name loop-morning-report \
  --deliver wecom \
  --workdir <项目> \
  "生成 <项目> 的晨报：
1. 跑 loop --cwd <项目> --status 获取状态
2. 读 .task.md 统计任务完成情况（已完成 [x] / 未完成 [ ] / 阻塞 [~] / 总数）
3. 读 night_run.log 末尾 50 行获取最近执行情况
4. 读 state.json 的 loop_count、status、event_counts 字段
5. 读 events.jsonl 末尾 20 行，提取 task_completed / task_blocked / aborted / done 等关键事件
6. 跑 git -C <项目> log --oneline -20 --since=yesterday 检查代码提交

输出中文 markdown 晨报：任务总进度 / 当前状态 / 进行中任务 / 代码提交情况（commit 数量+内容摘要）/ 异常汇总（如有）/ 结论。"
```

## 3. 微信推送：企业微信群机器人

### 3.1 配置企业微信

Hermes 内置企业微信支持。`hermes setup`（或 `hermes config`）里填群机器人 webhook URL，配好后 `--deliver wecom` 即可推送。

### 3.2 投递目标

```bash
--deliver wecom                # 默认企业微信渠道
--deliver wecom:<group_id>      # 指定群（group_id 从渠道列表查）
```

查可用渠道：看 `~/.hermes/channel_directory.json` 的 `wecom` 段——`type:group` 是群、`id` 即 group_id；`type:dm` 是单聊。

### 3.3 战报格式参考

三种场景（推进中 / 有异常 / 全部完成）的参考格式见 [skill/SKILL.md](skill/SKILL.md)。文案/格式/频道全由你定，loop 只保证结果结构化落盘，不掺和战报生成。

## 常用操作

```bash
hermes cron list                  # 看所有定时任务
hermes cron pause <id>            # 暂停某任务
hermes cron resume <id>           # 恢复
hermes cron rm <id>               # 删除
loop --cwd <项目> --stop          # 主动停 loop（watchdog 检测到 .stop 不再拉起）
loop --cwd <项目> --resume        # 清 .stop 恢复
loop --cwd <项目> --status       # 实时状态
loop --cwd <项目> --report        # 运行报告
```

## 解耦关系

- **loop --watch** 自驱推进，崩了 `state.json` 续跑（不丢进度、不重复打勾）
- **Hermes** 守护进程（watchdog 崩了拉起）+ 定时读结果组织战报
- **企业微信** 只收战报

watch 挂了 → watchdog 2 分钟内拉起；Hermes 挂了 → loop 继续跑（只是暂时没战报）；企业微信挂了 → loop 和 Hermes 都不受影响。
