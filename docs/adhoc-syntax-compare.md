## /agents:adhoc 语法对比

> **DECISION RECORD（已定稿）**：本文件是 spec 002 开发期间的设计对比讨论。
> 最终决策采纳了方案 **(c) 长 flag**——与现有 `/agents:*` 命令风格一致、自描述、无路径/文本二义性——并已由 `specs/002-adhoc-pane-agent.md` §3.6 实现（`parseAdhocArgs`）。
> 方案 (a) sticky `--` 因路径/文本二义性误用风险高被否；方案 (b) 短 flag 为退路但未采用。
> 本文件仅作历史设计记录，不作为当前语法的权威参考；当前语法见 README "Ad-hoc pane agent launch" 章节。

**问题**：用户要 `/agents:adhoc <name>` 加 0–n 个 prompt 文件 + 1 个 task，语法要简洁。

**输入维度**（按 spec 002 §3.6 现有 capability）：
- `name`（必填）
- prompt 来源：0..n 个，每个要么是文件路径，要么是 inline 文本
- task：1 个，要么是文本，要么是文件
- pane flag：可选，默认 `--pane`

**三选项对比**：

### (a) 位置 + sticky `--`

- **形态**：`<name> [<prompt-arg>...] -- <task-text>` 或 `<name> [<prompt-arg>...] --file <task-file>`
- 解析规则：找 `--`（或 `--file`）；`--` 之前是 prompt args，之后整个余串是一个 task 文本；`--file` 之后是 task 文件路径
- 每个 prompt arg 走 **path-vs-text 自动判别**：先 `fs.existsSync` + `isFile()`，命中则读文件，否则整段当 inline 文本
- 解析复杂度（pseudo-LOC）：~45 行 `parseAdhocArgs`
  - split + 找 `--` 标记 ~10 行
  - 路径/文本二选一解析器 ~15 行
  - pane / --file 分支 ~10 行
  - 错误信息 + fallback ~10 行
- 测试矩阵大小：12–15 case
  - 仅 name + task 文本（最常见）
  - 仅 name + task file
  - name + 1 个 prompt file + task 文本
  - name + 多 prompt file（混合顺序）+ task 文本
  - name + 1 个 prompt text + task 文本
  - name + prompt file 不存在 → 报错 vs 当文本兜底
  - `--` 缺失 → 末位 arg 当 task
  - `--file` vs `--` 冲突
  - pane flag 默认 / `--no-pane`
  - name 缺失 → usage error
  - 误把 task 文本含 `--` 的边界
  - shell metacharacter in prompt text
  - 空 prompt + task → 空 pi
- shell completion 友好度：**中**。`name` 可以补 agent 名字；prompt args 路径/文本混合，complete 难以猜
- 误用风险：**高**。"`be terse`" 想当文本，但如果 cwd 里碰巧有个文件叫 `be` 就被吞了；用户写错路径会**静默**变成 inline 文本而不是报错
- 样例：
  - `/agents:adhoc review-subagent-tmux ./base.md ./overlay.md -- "review spec 002"`
  - `/agents:adhoc reviewer "be terse, focus on security" -- "audit the auth"`
  - `/agents:adhoc researcher ./notes.md --file task.md`

### (b) 短 flag

- **形态**：`<name> [-p|--prompt <text>] [-f|--prompt-file <path>]... [-t|--task <text>] [-F|--task-file <path>] [--no-pane]`
- 解析规则：flag table；`-p` / `-f` 可重复；`-t` / `-F` 互斥
- 解析复杂度（pseudo-LOC）：~55 行 `parseAdhocArgs`
  - flag table ~10 行
  - repeatable flag 累加器 ~10 行
  - 互斥检查（-t vs -F）~5 行
  - 助记符文档 / 错误信息 ~15 行
  - pane flag ~5 行
  - name 必填 + 余下杂项 ~10 行
- 测试矩阵大小：18–22 case
  - 每个 flag 的 happy path × 2（短 / 长）
  - 互斥冲突（`-t` + `-F`）
  - `-p` / `-f` 重复 1 次 / 多次 / 0 次
  - 缺失 name / 缺失 task
  - `--no-pane` 单独 + 跟别的混
  - flag 后值缺失
  - 未知 flag
  - 短长 flag 混用（`-p "x" --prompt-file ./y.md`）
- shell completion 友好度：**中–高**。`-f` 和 `-F` 都可以绑 file completion；`-p` 和 `-t` 是文本
- 误用风险：**中**。助记符 `-p` / `-f` / `-t` / `-F` 区分度够，但 `-f` 和 `-F` 大小写对应 prompt file vs task file 容易混（`F` 是大写还是小写靠大小写区分）
- 样例：
  - `/agents:adhoc review-subagent-tmux -f ./base.md -f ./overlay.md -t "review spec 002"`
  - `/agents:adhoc reviewer -p "be terse, focus on security" -t "audit the auth"`
  - `/agents:adhoc researcher -f ./notes.md -F task.md --no-pane`

### (c) 长 flag（spec 002 §3.6 当前方案）

- **形态**：`<name> [--prompt <text>] [--prompt-file <path>...] [--task <text>] [--task-file <path>] [--pane|--no-pane]`
- 解析规则：`split(/\s+/)`，每个 flag 收集后值；`--prompt-file` 可重复
- 解析复杂度（pseudo-LOC）：~70 行 `parseAdhocArgs`
  - flag 表 ~15 行
  - 重复 / last-wins 逻辑 ~10 行
  - pane 双向 ~5 行
  - 错误信息 ~10 行
  - 杂项（empty value、unknown flag）~15 行
  - 测试辅助 / 调试日志 ~15 行
- 测试矩阵大小：25–30 case
  - 每个 flag 的 happy path
  - 重复 `--prompt-file` × N
  - `--task` + `--task-file` 冲突 → last-wins
  - `--pane` + `--no-pane` → last-wins（spec 002 §4.5 contract）
  - 空 value 处理
  - 引号不被 parser 处理（白盒行为）
  - name 缺失 / task 缺失
  - 路径含空格被切碎（已知限制）
- shell completion 友好度：**高**。每个 flag 语义清晰；可绑 `--prompt-file=` 路径补全
- 误用风险：**低**。长 flag 自描述；但**最啰嗦**，用户写起来累
- 样例：
  - `/agents:adhoc review-subagent-tmux --prompt-file ./base.md --prompt-file ./overlay.md --task "review spec 002"`
  - `/agents:adhoc reviewer --prompt "be terse, focus on security" --task "audit the auth"`
  - `/agents:adhoc researcher --prompt-file ./notes.md --task-file task.md --no-pane`

---

### 横评

| 维度 | (a) sticky | (b) 短 flag | (c) 长 flag |
|---|---|---|---|
| 简洁度（token 数/调用） | 8–12 | 10–16 | 18–28 |
| parser LOC | ~45 | ~55 | ~70 |
| 测试 case 数 | 12–15 | 18–22 | 25–30 |
| 误用风险 | 高（路径/文本二义性） | 中（大小写助记符） | 低（自描述） |
| shell completion | 中 | 中–高 | 高 |
| 与现有 `/agents:*` 一致性 | 新模式，需文档 | 新模式，需文档 | **一致**（spec 002 §4.5 已实现） |
| 用户学习成本 | 中（`--` 习惯） | 中（要记助记符） | 低（自描述） |

### 推荐：(a) sticky `--`

**理由**：用户的"语法简洁"诉求最直接的解是 (a)；token 数比 (c) 少 50%+，比 (b) 少 20%–30%。`--` 分隔符在 Unix CLI 是惯例（git、find、tar 都用），用户认知成本低。

**前提（必须同时落地）**：
1. 路径/文本二义性用 **prefix 约定** 消除：参数以 `.` / `/` / `~` 开头 → 当文件路径；否则当 inline 文本。不再做 `fs.existsSync` 兜底（避免静默吞错路径）。
2. `--file` 标记 task 来源是文件，没标记就是文本。task 也走同样的 prefix 约定。
3. pane flag 默认 on，需要 bg 时 `--no-pane`（不强制位置）。
4. shell completion 给 name 补 agent list，prompt arg 不补（混合语义）。
5. parser LOC 控制 ≤45，test matrix ≤15 case，否则"简洁"被复杂度吃掉了。

**如果你想更稳**：(b) 是 (a) 的退路——保留了 prompt/task 来源区分（`-f` 文件 / `-p` 文本），token 数比 (a) 多但比 (c) 少，且无二义性。
