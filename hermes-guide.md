# Hermes 最佳配置实战：任务执行 + 定时战报

loop --watch 自驱推进开发任务、把结果结构化落盘；Hermes 定时读结果、组织战报、推企业微信。

两个主题对仗：**任务执行**（loop 干活）/ **定时战报**（Hermes 观察+推送）。两者互不依赖，Hermes 不拉起、不守护 loop——各管各的。

## 前置

- **loop 没装？** 让 Hermes 读 [install.md](install.md) 自行装好（含 `~/.config/loop.env` 密钥/代理/模型配置，那条命令 + 填 key 就行）。
- **企业微信** 在 `hermes setup` 里配群机器人 webhook。

下文 `<项目>` 一律替换成你的项目绝对路径，如 `/home/you/work/myapp`。

## 1. 任务执行：拉起 loop --watch

```bash
loop --cwd <项目> "把缺陷表里失败的项全修了" 2>&1 | tee <项目>/night_run.log
```

`--watch` 自驱：bootstrap 拆任务 → `while(tick)` 推进 → 每轮 commit。崩了 `state.json` 续跑（不丢进度、不重复打勾）。

拉起/守护 loop 是你（或 systemd `Restart=always`）的事，**不是 Hermes 的**——Hermes 只读结果发战报。

> ⚠️ 目标项目绝不能是 loop 仓库自身，会污染 git 历史。

## 2. 定时战报：Hermes 读结果 + 推企业微信

loop 把结果结构化落盘（`state.json` / `events.jsonl` / `.task.md`），Hermes 定时读这些自行组织战报。loop 本身不掺和战报生成。

### 2.1 配置企业微信（前置）

Hermes 内置企业微信支持。`hermes setup`（或 `hermes config`）里填群机器人 webhook URL，配好后 `--deliver wecom` 即可推送。

投递目标：

```bash
--deliver wecom                # 默认企业微信渠道
--deliver wecom:<group_id>      # 指定群（group_id 从渠道列表查）
```

查可用渠道：看 `~/.hermes/channel_directory.json` 的 `wecom` 段——`type:group` 是群、`id` 即 group_id；`type:dm` 是单聊。

### 2.2 每 5 分钟状态推送

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

### 2.3 每日晨报

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

### 2.4 战报格式参考

三种场景（推进中 / 有异常 / 全部完成）的参考格式见 [skill/SKILL.md](skill/SKILL.md)。文案/格式/频道全由你定，loop 只保证结果结构化落盘，不掺和战报生成。

## 常用操作

```bash
hermes cron list                  # 看所有定时任务
hermes cron pause <id>            # 暂停某任务
hermes cron resume <id>           # 恢复
hermes cron rm <id>               # 删除
loop --cwd <项目> --stop          # 主动停 loop
loop --cwd <项目> --resume        # 清 .stop 恢复
loop --cwd <项目> --status       # 实时状态
loop --cwd <项目> --report        # 运行报告
```

## 解耦关系

- **任务执行（loop --watch）** 自驱推进，崩了 `state.json` 续跑（不丢进度、不重复打勾）。拉起/守护是用户或 systemd 的事，不是 Hermes 的。
- **定时战报（Hermes）** 只定时读结果组织战报、推企业微信。不拉起、不守护 loop。

loop 崩了 → Hermes 战报照样发、告诉你它挂了（状态停滞 / 心跳超时）；Hermes 挂了 → loop 继续推进；企业微信挂了 → 两者都不受影响。
