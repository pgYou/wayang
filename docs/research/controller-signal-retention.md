# Controller 上下文中历史 Signal 的折叠与淘汰调研报告

- 调研日期：2026-11-03
- 调研范围：Wayang 代码库（本地事实）+ 公开研究与工程文献（联网检索，来源见文末）
- 待裁决判断：
  - A：折叠旧 signal 在工程上是值得做的
  - B：收益主要不来自省 token，而来自「旧值必然被覆盖」这类结构性无用信息不该入历史
  - C：若实现方式是改写会话前缀，则因 prompt cache 失效，可能净亏
  - D：真正的上下文体积主因未必是 signal，需要先测量
  - E（追加）：面向多项目并行，「按项目分区驻留 + 状态面板替代叙述流」是比单纯折叠历史更根本的解法

联网访问：成功。本报告所有外部结论均来自实际抓取过的页面，来源以「标题 + URL」列于文末第 10 节；无法核实的说法明确标注为【推断】或「证据不足」。

---

## 1. 本系统现状：Signal 如何驻留在 Controller 上下文（代码事实）

以下是对 `src/` 的直接代码阅读结论，是后续所有判断的事实基础。

### 1.1 信号类型全集

`src/types/signal.ts` 定义 12 种信号类型（`SignalPayloadMap`）：

| 类别 | 类型 | 频率特征 | 语义 |
|---|---|---|---|
| 用户输入 | `input` | 事件式 | 用户指令，链的根 |
| 状态推进 | `progress` | 高频（worker 推送） | 增量进展叙述 |
| 状态推进 | `heartbeat` | 周期性（系统注入） | worker 运行中但无信号时的检查点，携带 workers 快照 |
| 终态 | `completed` / `failed` / `cancelled` / `task_cancelled` / `worker_disposed`（subtype） | 一次性 | 任务终态 |
| 交互请求 | `permission_request` / `worker_inquiry` / `inquiry_timeout` | 低频、阻塞态 | 需 controller 决策 |
| 元信息 | `message_undelivered` / `previous_session_tasks` | 会话边界 | 会话恢复类 |

关键事实：500ms 防抖（`ClaudeCodeWorker.PROGRESS_DEBOUNCE_MS`，`claude-code-worker.ts`）的设计目的是**与 completed 信号去重**（避免最后一条 assistant 摘要既作为 progress 又作为 completed 出现两次），不是对 progress 的限流。每条 progress 都会入队。

### 1.2 队列层已有两处「折叠」

`src/services/signal/signal-queue.ts`：

1. **unread progress 就地覆盖**（`enqueue` 内）：同一 worker 的新 progress 入队时，该 worker 所有仍处于 `unread` 状态的旧 progress 被置为 `discarded`。也就是说：**「旧值必然被覆盖」这一语义在队列层已经实现**——controller 每次唤醒读到的就是该 worker 的最新 progress，被覆盖的旧值从未进入会话。
   - 但该折叠只发生在「尚未被读走」的信号上。一旦某条 progress 被 `dequeueUnread` 读走（status → `read`），它就以 `SignalEntry` 形式**永久逐字驻留**在 controller 会话历史中。
2. **热窗口裁剪**（`trimWindow`）：`SignalState` 只保留最近 `DEFAULT_SIGNAL_WINDOW_SIZE = 2000` 条已处理信号；unread 永不丢弃（积压时可超窗）。注意这只约束 SignalState 的内存/落盘窗口，**不约束会话历史**——会话中的 SignalEntry 不受此窗口影响。

另外，`controller-loop.ts` 的唤醒模型本身就是「批量合并」：`waitForSignal()` 阻塞唤醒 → `dequeueUnread()` 一次取走全部 unread → **一次 controller LLM run 处理整批**。同一时间窗内积累的信号合并为一次唤醒、内容一条不丢，这在当前架构中已经成立（见第 5.4 节对唤醒粒度的展开）。

### 1.3 会话层：append-only 逐字驻留

`controller-agent.ts::_run`：每个 signal 经 `signalToEntry` 转为 `SignalEntry` append 进会话（JSONL 持久化，append-only）。发送给 LLM 时（`conversation-to-sdk-messages.ts`）渲染为 system role 消息：

```
[WORKER PROGRESS SIGNAL: PROGRESS task=tsk-123] <worker 的进展叙述全文>
```

从入会话起到 compaction 触发前，**所有历史 signal 全文逐字出现在 controller 每一回合的输入中**。

### 1.4 已有的压缩机制：compaction

`src/services/agents/context-manager.ts`：

- 触发：估算/实测 token 超过 `256k × 0.9`。
- 行为：LLM 摘要全部会话 → 摘要进入 system prompt 的 `[Conversation Summary]` 节 → 之后 `getMessages()` 只发送 compaction 之后追加的条目（verbatim zone）。JSONL 文件本身不改写，compaction 以 append 一个 `EEntryType.System` 标记实现（链边界）。
- fallback：`truncateHistory`（保留最新 N 条，内存层面）。
- **关键先例**：`summarizer-input.ts` 中 heartbeat 信号在摘要输入中被直接剔除（`if (entry.subtype === ESignalSubtype.Heartbeat) return null;`）——系统已经在「摘要时按类型区别对待信号」，只是没有在驻留层面区别对待。
- **关键代价**：compaction 改变了发送给 LLM 的前缀形状（system prompt 变长 + messages 列表截断），任何前缀式缓存（prompt cache / KV cache）在该时刻必然全部失效。

### 1.5 缓存现状：无显式配置

代码中无任何 `cache_control` / 断点配置；仅在 `build-assistant-entry.ts` / `controller-agent.ts` 记录 provider 返回的 `cachedInputTokens`（即只观测缓存命中，不主动经营缓存）。当前缓存行为完全取决于 provider 的隐式前缀缓存。

### 1.6 可测量性缺口

`ContextManager.getContextBreakdown()` 已有分组（systemPrompt / user / assistant / toolCalls / toolResults / compactSummary），但 SignalEntry 渲染为 system role 后**计入 user 组**——现有仪表无法回答「signal 占上下文多大比例」。这是判断 D 的直接可操作缺口：加一个 `signals` 分组是低成本的第一步。

### 1.7 多项目维度的现状

当前一个 session 一个 controller，所有项目的所有 signal 进入同一条会话历史，无任何分区机制。会话条目已带 turn lineage（`turnId` / `rootTurnId` / `causationId`），可作为未来按任务/项目分区的基础设施，但尚无消费者。

### 1.8 对判断的直接影响（小结）

- 判断 B 的核心主张「旧值必然被覆盖不该入历史」：系统在队列层已经这么做了（unread 覆盖），说明该语义与「每条都送达」并不冲突——冲突只发生在 read 之后的驻留层。
- 判断 C 的担忧对象在本系统是真实存在的：compaction 本身就是一次前缀改写。
- 判断 D 的测量工具已有一半（breakdown 机制），缺 signal 归因。

---

## 2. 长上下文退化：实证证据

### 2.1 核心实证研究

**Lost in the Middle（Liu et al., TACL 2023）** — arxiv.org/abs/2307.03172
- 方法：多文档 QA（10/20/30 篇文档，控制相关文档位置）+ KV 检索，与 closed-book / oracle 基线对照。
- 数字：GPT-3.5-Turbo 在 20 文档设定下，相关文档位于开头 75.8%、中部 53.8–57.2%、结尾 63.2%（U 形曲线）；**中部表现低于完全不给文档的 closed-book 基线（56.1%）**——「给了材料反而更差」。16K 长上下文版本与基础版基本持平（"Extended-context models are not necessarily better at using input context"）。
- 定位：**检索/位置类失败**（找不到针），非推理质量。

**Context Rot（Chroma 技术报告, 2025-07）** — trychroma.com/research/context-rot
- 方法：18 个前沿模型（Claude Opus 4/Sonnet 4/3.x、o3、GPT-4.1 系、Gemini 2.5/2.0、Qwen3），四组实验：NIAH 扩展（distractor 数量 0/1/4、针-干草相似度、干草结构）、LongMemEval_s（~300 token 聚焦输入 vs ~113K 全量输入）、Repeated Words 复现任务。
- 结论：18 个模型全部随输入变长退化，"even on trivially simple tasks"；**单个 distractor 就造成显著下降，四个叠加加剧**；LongMemEval 上聚焦输入显著优于全量输入，且 thinking 模式开启也未消除差距；**结构连贯的干草比打乱的干草更伤性能**——这对本系统是坏消息：progress 叙述流恰是「结构连贯的无关内容」。
- 局限（报告自认）：任务刻意简单，真实需要综合/多步推理的应用会退化得更严重；逐模型具体分数仅以图呈现，无可引用文本数字；Chroma 是向量库厂商，存在利益关联（HN 讨论区已指出）。

**NoLiMa（Modarressi et al., Adobe, ICML 2025）** — arxiv.org/abs/2502.05167
- 方法：针与问题无字面重叠的 NIAH，强制潜在关联推理；13 个声称 ≥128K 的模型。
- 数字（基线→32K）：GPT-4o 99.3→69.7，GPT-4.1 97.0→79.8，Claude 3.5 Sonnet 87.6→29.8，Gemini 1.5 Pro 92.6→48.2；**32K 时 11 个模型低于短文本基线的 50%**。论文将退化归因于无字面匹配时注意力检索失效——仍是检索机制故事。代际改善存在（GPT-4.1 优于 GPT-4o，o3 优于 o1）但未消除。

**RULER（Hsieh et al., NVIDIA, COLM 2024）** — arxiv.org/abs/2404.06654
- 方法：13 类合成任务（检索变体、多跳追踪、聚合、QA），「有效长度」= 保持某分数阈值的最长输入。
- 结论：17 个声称 ≥32K 的模型**只有一半能在 32K 维持满意表现**；vanilla NIAH 接近满分掩盖了其他任务的急剧退化。榜上部分模型（Gemini 1.5 Pro、Jamba 1.5、Qwen2.5-1M）确实达标 >128K——反方证据，但仅限合成任务。

**LLMs Get Lost in Multi-Turn Conversation（Laban et al., 2025）** — arxiv.org/abs/2505.06120
- 方法：把完整指令「分片」到多轮对话中逐步揭示，20 万+ 模拟对话、15 个模型、6 类生成任务；对照组（全部分片放同一条消息）平均 95.1%，排除分片本身的信息损失。
- 数字：多轮相对单轮**平均降 39%**（图注写 35%，论文内部不一致）；分解后能力（aptitude）仅 −16%（不显著），**不可靠性（跨 run 方差）+112%**；行为机制：「在早期回合做出假设并过早生成最终方案」「走错一步就回不来，不会自我恢复」。
- 对 controller 的特殊意义：调度是重复决策，方差增大（同样的信号序列，十次运行给出不同调度）比均值下降更致命。

### 2.2 「找不到针」vs「推理质量下降」

两类失败都有实证，且可区分：

| 类别 | 证据 | 机制 |
|---|---|---|
| 找不到针 | Lost in the Middle（位置 U 形）；NoLiMa（无字面匹配时检索失败）；CRE（2605.23170：中部错误 76% 逐字匹配 filler） | 注意力检索失败 |
| 推理质量下降（信息已获得或无需检索） | 见下 | 检索成功但判断退化 |

推理质量下降的直接证据：
- **Reasoning on Multiple Needles（2504.04150）**：退化主因是「输入变长导致 thinking 过程变短」，非检索失败。
- **DISCO（2609.33485, Adobe）**：单模型中「grounding 的搜索负担耗尽复杂推理所需的表征容量」；把 grounding（分片 worker）与 reasoning（驱动模型）解耦后在 1M token 上 RULER-QA 达 78.4%，LongBench v2 最高 +9.8 分——上下文负载损害推理的最干净因果证据。
- **Chroma LongMemEval**：thinking 全开后聚焦 vs 全量差距仍在。
- **Classifier Context Rot（2605.12366）**：**最可迁移的研究**——前沿模型做编码 agent 轨迹的安全监督者，同样的异常动作出现在 800K 良性活动之后，漏检率提高 **2–30 倍**。纯判断任务、无针。监督者面对长而几乎全 benign 的动态增长历史——与 controller 的角色完全同构。
- **Coding Agents 中的 Context Rot（2607.17937）**：技能遵循任务，干净上下文 8/10 通过，299K 字符相关上下文后 3/10（无关等长上下文同样 3/10）；但**需求覆盖率始终 >92%**——模型「找到了要求，执行却失败」。外部清单可恢复到 10/10（通用自查只有 5/10）。注意：n=10、p=0.0698，趋势级证据。
- **多轮论文**：损失以不可靠性为主（见 2.1）。

### 2.3 对「决策型 controller」的可迁移性

- **同构性最强的证据链**：Classifier Context Rot（监督者漏检 2–30×）+ Chroma coherent-filler 发现（连贯的无关叙述比随机噪声更伤）+ 多轮不可靠性（+112% 方差）。controller 正是「对长而单调增长的事件史做判断」的角色，不属于任何「找针」场景。
- **缓解手段的实证**：把决策标准作为外部清单重新呈现（10/10 恢复）；把关键任务复制到上下文末尾（CRE：中部精度恢复到 ±4pp）；持久状态放 transcript 之外（位置效应使埋在中部的老状态被忽略）。
- **反向证据（不得弱化）**：many-shot ICL（2404.11018）证明**相关**内容的堆叠可以提升性能——退化是关于「无关/稀释内容」而非长度本身；模型代际改善明显（NoLiMa 榜：GPT-4.1/o3 显著好于前代，但 32K 仍降 18–42 分）；Boolean AI 博客研究（仅 2 模型，定性参考）：Claude Opus 5 对 1.25MB 无关 prefill 表现平稳（0.50/0.52/0.48），但对**相关** prefill 从 0.50 降到 0.398；GPT-5.6 Sol 两者皆降且 10–20% 的试验中「坍缩进 prefill」直接接着旧上下文答题。
- **结论**：输入变长导致性能下降有强因果证据（任务固定、只变输入长度/位置/filler 的设计），且对监督型决策角色的可迁移性高；幅度取决于 filler 的相关性与语义相似度，随模型代际改善但不消除。「context rot」的准确表述是：**无关或稀释性材料累积时，准确率与可靠性在远未到达标称窗口前就开始退化**。

---

## 3. Prompt caching / KV cache 与历史改写的冲突

### 3.1 Anthropic prompt caching：计费与命中机制

来源：platform.claude.com/docs/en/build-with-claude/prompt-caching（2026-11 抓取）。

- **计费**：缓存写 = 基础输入价 ×1.25（5min TTL）或 ×2（1h TTL）；缓存读 = ×0.1（即 9 折优惠中的 90% off；部分新模型低至 ×0.025–0.05）。缓存命中不计入速率限制。例（每 MTok）：Sonnet 5.5 输入 $2 / 5min 写 $2.50 / 1h 写 $4 / 命中 $0.10 / 输出 $10。
- **最小可缓存长度**：512–4096 token（按模型），低于下限标记 cache_control 也不缓存且不报错。
- **断点**：最多 4 个；缓存按「截至断点的前缀哈希」写入。
- **失效规则**：层级 tools → system → messages，「每层的变化使该层及其后所有层失效」；「命中要求 100% 逐字节一致的 prompt 段」；改任何更早的块都会改变累计哈希。messages 层的失效触发还包括 tool_choice 变化、任意位置增删图片、thinking/effort 配置变化（被渲染进 prompt）、切换模型。
- **增量缓存**：未命中时系统逐块回看（窗口 20 块）寻找可复用前缀——多轮对话每回合「读旧前缀 + 写新尾巴」。
- **TTL**：默认 5 分钟（每次使用免费刷新），1h 可选；「TTL 从写入或读取该缓存的请求开始计」。
- **延迟**：官方称显著降低处理时间与 TTFT，未给出数字。

其他 provider 同为前缀语义：Azure/OpenAI「首 1024 token 必须完全一致，一个字符不同即 miss」，官方最佳实践明文 **"Keep conversation context append-only"**（learn.microsoft.com/en-us/azure/ai-services/openai/how-to/prompt-caching）；Gemini 2.5+ 默认隐式前缀缓存（aistudio.google.com/docs/caching）；DeepSeek 磁盘前缀缓存默认开启（api-docs.deepseek.com/guides/kv_cache）。

### 3.2 Anthropic 官方长上下文手段：改不改前缀

| 机制 | 客户端历史 | 发送给模型的前缀 | 缓存影响 |
|---|---|---|---|
| Context editing（清除工具结果，beta） | **不改**（"Your client application maintains the full, unmodified conversation history"，服务端替换为占位符） | 改（旧 tool result → 占位符） | 「在清除点失效」；文档承认这是权衡，提供 `clear_at_least` 让你判断「值不值得为此破缓存」 |
| Memory tool（稳定版） | **纯增量**（memory 调用是普通 tool use，状态存文件） | 不改 | 前缀保持，构造性安全 |
| Compaction（API + Claude Code） | Claude Code JSONL 保留全量；会话内消息被摘要替换 | **改写**（"Compaction replaces your message history with a summary... invalidates the conversation layer"） | 会话层缓存全失效；system/project 层保留 |

Claude Code 的配套实践（code.claude.com/docs/en/prompt-caching、claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything）：
- 摘要调用被设计成 **cache-safe fork**：与父对话用完全相同的 system prompt/tools/history，把 compact 指令作为新 user message 追加在末尾——「对 API 而言这次请求与父请求几乎相同，缓存前缀被复用」。
- 计划模式用 EnterPlanMode/ExitPlanMode 工具而非中途改 toolset（「改工具集是破坏缓存最常见的方式」）；一切更新以追加的 system-reminder 交付；「静态内容在前，动态内容在后」。
- **Idle compaction**：1h 订阅缓存在过期前，闲置约 54 分钟的会话被主动 compact——**官方自己在缓存注定失效的时刻用新鲜度换历史**。成本页把 compaction/工具结果清除标注为 "expected rebuild"（预期内的重建）。
- best-practices 页已把「上下文窗口是你的主要约束，激进管理它」列为**过时建议**（1M 窗口 + 自动 compaction 时代）。

### 3.3 Manus 的 append-only 论证

来源：manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus（Yichao "Peak" Ji, 2025-07-18，两个代理独立抓取，引文一致）。

- "the KV-cache hit rate is the single most important metric for a production-stage AI agent"（生产级 agent 最重要的单一指标）；"the average input-to-output token ratio is around 100:1"（输入输出比 ~100:1）；缓存命中 $0.30/MTok vs 未命中 $3.00/MTok（10 倍）。
- "Keep your prompt prefix stable." / "even a single-token difference can invalidate the cache from that token onward" / **"Make your context append-only." "Avoid modifying previous actions or observations."** / "Ensure your serialization is deterministic."（JSON key 顺序不稳定会静默破缓存）。
- Mask, Don't Remove：工具定义在头部，改它就全失效——所以用状态机屏蔽工具可用性而非编辑历史。
- 文件系统作为终极上下文；压缩必须可恢复（丢页面内容留 URL）；todo.md 不断重写 =「把目标复诵进上下文末尾」；"leave the wrong turns in the context... Erasing failure removes evidence."

### 3.4 对该论证的弱化因素（反方向证据）

1. Anthropic 自家机制接受**有界**缓存损失：context editing / compaction 都在选定点击穿缓存再重建，官方文档将其框定为预期成本而非失败。
2. 经济学上并非灾难：重写段一次性付 1.25×，之后读回到 0.1×；若被折叠内容本来每回合都以 0.1× 计价（缓存命中），「省 token 钱」的边际收益其实很小——这是判断 B 中「收益不主要来自省 token」的定价侧依据。
3. 缓存本来就会因时间死亡（默认 5min TTL）；Claude Code 甚至主动在过期前 compact。
4. Manus 自己也偏离纯 append-only（屏蔽工具、可恢复压缩）。
5. 1M 窗口时代，Anthropic 官方已不把上下文管理列为主要约束。

### 3.5 对本系统的精确含义：三种折叠实现，缓存后果完全不同

关键认识：**缓存匹配的是「发送形状」而非「存储形状」**。Wayang 的 JSONL 本来就是 append-only；全部问题集中在 `getMessages()` 的输出。设折叠有三种实现：

- **(a) 中段改写**：把会话里旧的 signal 条目替换/删除后重新发送。每次折叠使 messages 层缓存全量失效并整段重付 1.25×（且 5min TTL 下可能还没攒回成本就再折叠）→ **判断 C 在此实现下完全成立，可能净亏**。
- **(b) 入口折叠**：在 signal → SignalEntry 转换时就决定形态（如旧 progress 降为一行索引、heartbeat 不入会话），历史照常 append。缓存安全，但**已经驻留的内容无法回收**，只对增量有效。
- **(c) 边界重建**：选定时机一次性折叠，接受一次有界的缓存重建（同 compaction / context editing 模式），配 `clear_at_least` 式的「值不值」判断。这是 Anthropic 官方自己在用的模式。

结论：C 不是「折叠不可做」，而是「折叠不得以任意中段改写实现」；合法形态是 (b) + (c) 组合，且 (c) 的摘要调用应仿 Claude Code 做成 cache-safe fork。

---

## 4. 多 agent 协作：「完整轨迹」与「摘要/折叠」的争论

### 4.1 Cognition：Don't Build Multi-Agents（Walden Yan, 2025-06）

来源：cognition.com/blog/dont-build-multi-agents（cognition.ai 旧链 301 至此）。

- 两原则原文："Share context, and share full agent traces, not just individual messages"；"Actions carry implicit decisions, and conflicting decisions carry bad results"。作者认为这两条「几乎不值得违反，默认应排除任何不遵守它们的架构」。
- 失败模型：Flappy Bird 例子——两个并行 subagent 在部分信息下做出「冲突的隐式决策」（背景做成马里奥风格、鸟的动作完全不对）；推广为「多数真实任务有多层 nuance，都可能在传递中被误传」；多 agent 协作的决策「过于分散，上下文无法充分共享」→ 脆弱系统。
- **两处常见误读必须纠正**（本文实际立场比传言温和）：
  1. 文中**没有**「30 分钟规则」。
  2. 它**不反对压缩本身**：对单线程 agent 的上下文溢出，它认可用专门的（微调）模型「把行动与对话历史压缩为关键细节、事件与决策」，只是强调「这很难做对」。Cognition 反对的是**在 actor 边界上做有损传递**，不是「保留一切」。
- 它对 Claude Code subagent 的引用是正面的：「subtask agent 通常只被要求回答问题而非写代码」，好处是「subagent 的全部调查工作无需保留在主 agent 的历史中」——即：**问答型/调查型 subagent 的中间过程不入主历史，是 Cognition 自己认可的模式**。

### 4.2 Anthropic：多 agent research 系统（2025-06）

来源：anthropic.com/engineering/built-multi-agent-research-system。

- 架构：lead agent 规划并派发并行 subagent，各自独立上下文窗口；「搜索的本质是压缩」；subagent 回传「对 lead 最重要 token 的浓缩」；产出写文件系统、**回传轻量引用**以防多级传递中的信息损失。
- 数字：agent 用约 4× 于 chat 的 token，多 agent 约 15×；「token 用量单独解释了 BrowseComp 80% 的性能方差」；多 agent（Opus 4 lead + Sonnet 4 subagents）在内测上超单 agent Opus 4 90.2%；并行工具调用将复杂查询的研究时间最多缩短 90%。（网上流传的「单 agent 55%」数字**不在原文中**，未能核实。）
- 明确让步：「需要所有 agent 共享同一上下文、或 agent 间依赖很多的领域，今天不适合多 agent」——正是 Cognition 的编码域。

### 4.3 分歧的实质

两家说的「上下文」不是同一个东西，失败模型也不同：

| | Cognition | Anthropic |
|---|---|---|
| 「上下文」的含义 | 决策与观察的完整记录（多轮对话+工具调用） | 注意力预算（有限、边际收益递减） |
| 失败模型 | **有损交接**：部分视图下的并行 actor 做出冲突的隐式决策 | **context rot 与吞吐限制**：单 agent 淹没在自己的历史里，探索慢且局部 |
| 优化目标 | 决策一致性（编码域：动作携带隐式决策） | 广度与信息吞吐（研究域） |
| 对压缩的态度 | 单线程内可用专门模型压缩；跨 actor 边界禁止 | subagent 内部消耗数万 token、回传 1–2K token 摘要是核心模式 |

实质：这不是「要不要压缩」之争，而是**压缩发生在哪一层**之争——Cognition 禁止在「决策交接面」上压缩，Anthropic 在「执行面」上压缩、在「协调面」上保留浓缩结果。

### 4.4 实证：MAST 失败分类学（Cemri et al.）

来源：arxiv.org/abs/2503.13657（注意：搜索引擎常给出错误 ID 2505.05926，实际那是增量学习论文）。1,642 条标注轨迹、7 个开源 MAS 框架、14 种失败模式、3 大类（κ=0.88）：

- 系统设计 ~44%：不服从任务规格 11.8%、步骤重复 15.7%、不知终止条件 12.4%、**丢失会话历史 2.80%**
- **inter-agent 失调 ~32%**：推理-行动不一致 13.2%、任务脱轨 7.4%、忽略其他 agent 输入 1.9%、信息扣留 0.85%
- 验证 ~23%：无/不完整验证 8.2%、错误验证 9.1%

对本报告关键的两点：**「丢失会话历史」只占 2.8%**——截断/压缩导致的信息丢失在实践中是低频失败；而 inter-agent 失调占约三分之一——信息在 agent 之间**传递不良**（而非丢失）才是大头。这对判断 B 有双向含义：折叠的信息损失风险被 MAST 数据稀释，但「折叠后的形态如果传递了错误印象」会落入 32% 的大桶。

### 4.5 轨迹压缩的直接实证

- **AgentPrune（arxiv 2410.02506）**：对 MAS 时空消息传递图做一次性剪枝；6 个基准上 $5.6 vs SOTA 拓扑的 $43.7，token 减 28.1–72.8%，性能「相当」；对抗攻击场景 +3.5–10.8%。→ **多数 agent 间消息量是冗余的**，剪掉不伤性能（但也别指望涨）。
- **RE-TRAC（arxiv 2602.02486）**：深度搜索 agent 的递归轨迹压缩——每条搜索轨迹后生成结构化状态表示（证据/不确定/失败/计划），后续轨迹以它为条件；BrowseComp 上超 ReAct 15–20%，token 单调下降。→ **结构化**状态压缩（留决策、失败、未决问题）可以同时赢成本与准确率。
- **Anthropic 官方警告**："overly aggressive compaction can result in the loss of subtle but critical context"（过度激进的压缩会丢失微妙但关键的上下文），建议「先最大化召回，再迭代提高精度」。
- 净结论：**输赢取决于留下什么结构，而非压缩与否**。这与 Manus 的可恢复压缩（丢内容留指针）一致。

### 4.6 对本系统的含义

- controller 监督 worker ≠ Anthropic 的「lead 做研究」也 ≠ Cognition 的「并行 coder」。最贴近的公开对应物是 **Manus Wide Research**（manus.im/blog/manus-wide-research-solve-context-problem）：n 个并行子 agent 各自全新上下文、**互不通信、全部协调经主控**，主控「不被原始研究负担」所以能综合；他们的失败模型是「多任务顺序处理到第 8–9 个条目开始编造」（前 5 个真实、6–8 微妙退化、9+ 编造）。
- Cognition 的警告在本系统对应：controller 的调度/拆解决策本身就是「携带隐式决策的动作」。若它基于折叠后的印象给两个有依赖的 worker 分工，就复现 Flappy Bird。对策二选一：(i) 显式拥有跨任务决策（把接口/规格写进任务描述），或 (ii) 保留按需拉取全量的通道——本系统 `read_worker_conversation` 的分页读取正是 (ii) 的对应物，**折叠不得破坏该通道**。
- Anthropic 的 1–2K token 浓缩回传 + 文件引用模式，是「worker→controller」边界的现成参照。

---

## 5. 追加维度：多项目并行下的 Controller 上下文组织

前提：一个常驻 controller 同时监督 N 个项目的多个 worker，各项目事件进入同一条会话历史。

### 5.1 业界如何组织 lead/supervisor 管多并发子 agent 的上下文

- **Anthropic research 系统**：lead 只看浓缩回传（1–2K token/子 agent）+ 文件引用；lead 自己的计划存 Memory 而非塞在对话里。
- **Claude Code subagents**（code.claude.com/docs/en/sub-agents）：subagent 在全新隔离上下文运行，「只返回摘要」，详细输出不进主对话；默认并发上限 20、嵌套深度 3；**后台 subagent 的结果作为「完成通知」在后续回合到达**——不为每个事件唤醒主 agent；警告：subagent 描述本身占主上下文（合计 15K token 以上有警示）。
- **Letta Conversations**（letta.com/blog/conversations）：一个 agent 并发处理多会话——「每个 Slack 线程一个 conversation，数百线程并行喂进同一个 agent 的记忆」；作用域规则：单 agent 多 conversation = 共享记忆；多 agent = 记忆隔离。这是「分区 vs 隔离」决策的成文先例。
- **Manus Wide Research**：并行子 agent 全新上下文、互不通信、协调全走主控（「防止上下文污染并保持独立性」）。
- **MIRIX（arxiv 2507.07957）**：六类记忆各配专属记忆 agent + Meta Memory Manager 路由；每个事件只路由给相关分区；回答时只注入每分区检索出的 top-10，**从不加载原始对话全文**；LoCoMo 85.38% vs 全量上下文上限 87.52%。

### 5.2 跨项目交错的失效模式（实证）

1. **单条无关信息即可脱轨**：GSM-IC（arxiv 2302.00093，ICML 2023）——GSM8K 加入一句无关句子，CoT 宏准确率从 95.0 掉到 6.0（micro 72.4）；提示「忽略无关信息」仅恢复到 15.0。这是「A 项目的心跳插进 B 项目推理中段」最近的实验室类比。
2. **distractor 数量与语义相似度放大伤害**：Chroma——单个 distractor 即显著降、四个叠加；**结构连贯的无关内容比打乱的更伤**（5.2.1 的连贯 progress 叙述是更坏的情况）。NoisyBench（arxiv 2601.07226）——含「无关聊天记录」在内的一类噪声使 SOTA 模型最高降 80%，agent 场景因「过度信任噪声工具输出」而放大，且 **inverse scaling：更多测试时计算使噪声场景更差**；注意力可视化显示模型不成比例地聚焦 distractor token。
3. **早期污染不可恢复**：多轮论文——「走错一步就回不来」；跨项目交错时，A 项目的早期错误假设可以捕获 B 项目的推理。
4. **归属混淆的直接观察**：Boolean AI（仅 2 模型的博客研究，定性参考）——GPT-5.6 Sol 在 10–20% 试验中「坍缩进 prefill」，直接接着旧上下文的问答继续作答。这是跨上下文串扰的可见形态。
5. **协调面的实证频率**：MAST inter-agent 失调 ~32%（任务脱轨 7.4%、忽略他方输入 1.9%）；Anthropic 自家观察到 lead 被「excessive updates」干扰、两个 subagent 重复搜索同一主题；Manus「Don't Get Few-Shotted」：重复的动作-观察模式诱发模仿、漂移、幻觉——**同形状的高频心跳/进度正是这种模式**。
6. **注意力挤占**：Anthropic context engineering 博客的「attention budget」框架；Chroma LongMemEval 聚焦 ~300 token 输入显著优于 ~113K 全量。

### 5.3 上下文预算分区：双层结构（项目预算 + 全局预算）的先例

- **最直接的先例是 Letta memory blocks**（docs.letta.com/v1-sdk/memory/memory-blocks/ + letta.com/blog/memory-blocks）：带 `label`/`description`/`value`/**`limit`（字符上限）** 的结构块，渲染时附 `chars_current`/`chars_limit`（预算对模型本身可见）；块可跨 agent 共享；上下文在推理时从 DB 状态「编译」；kernel 上下文（system prompt、工具、记忆块——只能经 memory_* 工具改）与 user 上下文（消息缓冲）分层。
- **Mem0**（docs.mem0.ai/platform/features/entity-scoped-memory）：`agent_id`/`app_id`/`run_id` 命名空间 + AND/OR 过滤 + 按 `run_id` 的生命周期清理（`delete_all`）——**按作用域驻留与淘汰**的成文先例。
- **MIRIX**：按记忆类型分区 + 路由（见 5.1）。
- **GCC（arxiv 2508.00031）**：类 git 的上下文版本控制（COMMIT/BRANCH/MERGE），SWE-Bench Verified 超 13%、>80% 成功率。
- **MemPrice（arxiv 2610.24955）**：把活动上下文当作带价格共享资源做在线分配，每轮硬预算 + regret 保证。
- **必须如实说明**：**按「项目」分区的预算（区别于按记忆类型/按用户）没有直接的公开先例**——该方案是由 Letta 的每块限额 + Mem0 的命名空间 + MIRIX 的路由拼装而成，属于有依据的组合而非已验证的成品。

### 5.4 唤醒/调度：批量唤醒 vs 每事件唤醒

- **非 LLM 工程先例**：中断合并（en.wikipedia.org/wiki/Interrupt_coalescing）——中断被刻意延迟到「积累一定工作量或超时」，可「把中断负载降低一个数量级」而延迟代价小；**硬件 FIFO/DMA 保证中断被扣住时数据继续入内存——不丢，只延迟交付**。rAF（developer.mozilla.org）：同帧多个回调合并为一次重绘、共享同一时间戳。Chrome 88 定时器节流：相似超时的计时器批量到每分钟一次检查，同时给可见页面/音频留例外以保交互。
- **LLM agent 先例**：Claude Code 交互模式的消息队列（code.claude.com/docs/en/interactive-mode）——工作中键入的消息排队，「工具调用一结束就在同一回合内送达」「回合结束时剩余消息按输入顺序自动发出」，并提供手动立即发送/中断/撤回；后台 subagent 结果作为完成通知到达后续回合；LangGraph 并行 interrupt 用 ID→值映射一次性恢复（docs.langchain.com/oss/python/langgraph/human-in-the-loop）；OpenAI Agents SDK 的 interruptions 批量携带混合审批项、允许部分解决其余保持暂停。**所有核实过的先例都是「缓冲」而非「丢弃」**；AutoGen 的 UserProxyAgent 是反例（阻塞、无批量）。
- **本系统现状**：`waitForSignal()` 阻塞唤醒 + `dequeueUnread()` 整批出队 + 一批一回合，已经是「时间窗内合并唤醒、内容一条不丢」；500ms 防抖与队列层 unread progress 覆盖进一步合并。**该模式在本系统已基本落地**，剩余问题只是粒度参数（如 controller run 期间的信号天然滚入下一回合，是否再加最小唤醒间隔属于调参而非架构）。
- 利弊：批量降低回合数与缓存压力（回合间 append-only 使前缀稳定，Manus 10× 价差由此保住）并天然抑制「每事件一醒」的抖动；代价是唤醒延迟（权限请求等阻塞型信号需要立即触发或缩短窗口——中断合并的「例外名单」思想适用）。

---

## 6. 成本与延迟的量级

### 6.1 关系式（实证来源见括号）

- **TTFT / prefill 延迟**：prefill 是计算受限阶段（Splitwise, arxiv 2311.18677："TTFT ... grows almost linearly as the prompt size increases"，实测 1–4K 区间）；注意力项随长度平方增长（Longformer/MInference），大 prompt 下成为主导——**8B 模型在单张 A100 上 prefill 1M token 需约 30 分钟**（MInference, arxiv 2407.02490）。两者不矛盾：线性项（每 token 2·P FLOPs，kipply 的 transformer-inference-arithmetic）在 ~数万 token 内主导，平方项其后接管。
- **解码速度**：decode 是访存受限（每步读全部 KV cache）；32K 上下文时 Llama-7B 的 16GB KV「至少要 11ms 才能读完」、占推理延迟 50%+，KV 装载占 decode 阶段时间的 53%（Quest, arxiv 2406.10774）。KV 内存每 token 约 0.1–2MB（OPT-13B 实测 800KB/token，vLLM 论文 arxiv 2309.06180）→ **每 token 解码时间随上下文长度近似线性变慢**。
- **每回合费用**：API 无状态，「输入阶段=全部历史+当前消息」，故未缓存时**每回合输入费用 ∝ 会话总长**（线性重付）。多数当前模型按 token 平价计费（Claude 4.6+："A 900k-token request is billed at the same per-token rate as a 9k-token request"）；长上下文溢价仍存在于部分产品：Gemini Pro 系 >200K 输入 2×/输出 1.5×，Claude Haiku 5.5 >100K 时 5×（aistudio.google.com/docs/pricing、platform.claude.com/docs/en/about-claude/pricing）。
- **缓存的杠杆**：命中读 0.1×、且**跳过整个 prefill**——Anthropic 实测 100K token prompt 的 TTFT 从 11.5s 降到 2.4s（−79%），长 prompt 延迟最多降 85%、成本最多降 90%（claude.com/blog/prompt-caching）。

### 6.2 量级锚点（区分实测与推断）

实测锚点：100K 输入未缓存 TTFT ≈ 11.5s（Claude 3.5 Sonnet 生产数据）；8B/1M/单 A100 prefill ≈ 30min；1M token 序列的 KV 占数十 GB～1TB 级（0.1–2MB/token 推算）。
【推断】单卡 H100/A100 prefill 吞吐 ~0.06–0.12 ms/token，线性外推 100K ≈ 6–12s、1M ≈ 1–2min——**但该外推在 ~30K 以上失效**（平方项接管），可信的大 L 锚点是 MInference 的 30min。
【推断】生产级 1M 未缓存输入的每回合成本：以 Gemini 2.5 Pro 价格表推导约 $2.25/回合（1.8× 平价），对比 1K 对话 prompt 的 $0.00125——**三个数量级**。缓存命中时降到 ~1/10。

### 6.3 对本系统的现实含义

- Wayang controller 每回合重付全部历史输入；在 256k 预算内未缓存的极端回合，TTFT 以十秒计、费用线性堆叠。**signal 折叠对未缓存前缀的每回合节省 = 被折叠 token 数 × 平价单价**；对已缓存前缀 = 折叠 token × 0.1×（小）——但缓存命中依赖前缀稳定，见第 3 节。
- 1M 级上下文的名义可用性已被 RULER/NoLiMa 的独立评测打了对折（第 2 节），Llama 4 Scout 声称 10M 但发布时没有任何服务商开放超过 328K（simonwillison.net/2025/Apr/5/llama-4-notes/）——**「窗口够大所以不用管」不成立**。
- 唯一的反例数据点：Sonnet 4.5 的 1M 配置在 SWE-bench Verified 上 78.2% vs 200K 配置 77.2%（claude.com/blog/claude-sonnet-4-5）——更长窗口没有伤害该基准，但也仅此一个点。

---

## 7. 事件流型历史的业界处理方式

### 7.1 各系统对照（全部来自实际抓取的文档）

| 系统 | 全量事件史进模型上下文？ | 截断（占位符） | LLM 摘要 | 状态快照 | 卸载到文件/存储 |
|---|---|---|---|---|---|
| Anthropic context editing | 客户端保留全史；服务端只清旧工具结果 | 是（最旧优先，keep=3，占位符） | 可选（服务端 compaction 为主策略） | 否 | 否 |
| Claude Code | JSONL 全量在盘；上下文涨到阈值 | 是（工具结果清除，"expected rebuild"） | 是（auto-compact：200K/967K/1M 边界；保留请求与关键代码片段） | 部分（CLAUDE.md/记忆/技能压缩后从盘再注入；最多重读 5 个文件） | 是（subagent 隔离工具调用；>50K 字符工具结果落盘） |
| OpenAI Agents SDK | Session 后端保全史 | 是（ToolOutputTrimmer：recent_turns=2 保护，>500 字符→200 字符预览） | 可选（ResponsesCompactionSession） | 否 | 是 |
| LangGraph | 否——每超步 checkpoint 是通道状态**快照** | 否 | 应用层 | **是**（按 thread_id 的图状态快照） | 是 |
| MemGPT/Letta | 否——主上下文只有 FIFO 消息队列 | 70% 警戒/100% flush 淘汰 | 是（递归摘要替换被逐消息） | 是（自编辑的工作上下文块） | 是（recall storage 分页检索；现行 Letta MemFS：仅 system/ 文件进 prompt） |
| OpenHands | append-only 事件日志为事实源；模型只见派生 View | 中段事件从 View 丢弃 | 是（默认 LLMSummarizingCondenser：保留头尾+摘要中段） | 否 | 是（两级 Markdown 记忆，MEMORY.md 限 ~6K 字符注入） |
| SWE-agent | 全轨迹存盘；发模型的是过滤副本 | 是（LastNObservations n=5，"Old environment output: (n lines omitted)"；**polling 参数的存在明确为了减少缓存失效**） | 否（regex 删除/打标） | 否 | 是 |
| Manus | append-only 前缀保 KV cache | 避免不可逆截断 | 仅可恢复压缩（丢内容留 URL/路径） | todo.md 作为被复诵的显式状态 | 是（「文件系统是终极上下文」） |

### 7.2 提炼出的共识模式

没有任何被核实的系统把高频事件流全文无限期喂给模型。一致架构是四层：

1. **append-only 原始日志放在模型之外**（OpenHands 事件日志、Claude Code JSONL、MemGPT recall storage、Anthropic「客户端保留完整未修改历史」）；
2. **模型看到的是派生视图**——快照（LangGraph）或窗口/压缩前缀（其余全部）；
3. **高频低值事件最先被省略**，通常最旧优先 + 占位符让模型知道内容被移除了（Anthropic context editing 的占位符、SWE-agent 的 "(n lines omitted)"、OpenAI trimmer 的 "[Trimmed: ...]"）；
4. **持久状态从盘再注入**，保证摘要化不毁掉指令（Claude Code 重读文件/技能上限 5K/25K、OpenHands MEMORY.md、Manus todo.md 复诵）。

### 7.3 新近学术对应物

- **Context-Folding（arxiv 2510.11967）**：agent 按子任务分支出子轨迹，完成后「折叠」为结果摘要；活动上下文小 10×，且「显著优于基于摘要的上下文管理」——训练式版的事件折叠。
- **Solving Context Window Overflow（arxiv 2511.22729）**：论证截断/摘要都无法保留完整输出，改为「内存指针」替代原始数据，token 约 1/7。
- **Fowler 事件溯源**（martinfowler.com/eaaDev/EventSourcing.html）：通用软件工程的对应智慧——事件日志与当前状态并存，「系统记录可以是事件日志也可以是当前状态」，快照合法因为「状态可从日志完整推导」；event-carried state transfer 让消费者无需回源（martinfowler.com/articles/201701-event-driven.html）。
- **Wayang 对位**：本系统的 JSONL + SignalState 2000 条窗口 + compaction 已符合模式 1、2 的一半；缺模式 3（按类型/新旧的省略——heartbeat 在摘要层已剔除但驻留层没有）与模式 4（持久状态的盘上再注入——`[Conversation Summary]` 在 system prompt 中，但没有独立于会话的「当前状态面板」）。

---

## 8. 反方证据专节：折叠何时让系统变差

本节不弱化任何反方证据。若第 9 节的建议被采纳，以下每一条都是必须设防的失效面。

### 8.1 缓存失效（机制最明确的一条）

见 3.4/3.5。中段改写式折叠每次都使 messages 层缓存全量失效并整段重付 1.25×；5min TTL 下若两次折叠间隔小于「攒回缓存」的时间，**净亏**。Claude Code 成本页把 compaction/工具清除标注为 "expected rebuild"，说明连官方实现也承认这是一笔要预算的代价。本系统当前连 `cache_control` 断点都没有配置——在无显式缓存经营的现状下，改写前缀的损失全部落在隐式前缀缓存上。

### 8.2 审计链断裂

- MAST：「丢失会话历史」占 2.8%——罕见但真实存在的失败模式（"Unexpected context truncation, disregarding recent interaction history"）。
- Manus："Erasing failure removes evidence. And without evidence, the model can't adapt."——错误/异常信号对后续行为有适应价值，抹掉它们不只是丢信息，是丢训练信号。
- Cognition 原则一的字面要求是「分享完整 agent 轨迹」；折叠使 controller 侧的轨迹不再完整，任何依赖「controller 读过什么」的审计/回放/回归测试都要改为对照 SignalState 窗口与 JSONL。
- 本系统特定的审计资产：`query_signals` 只能查 SignalState 的 2000 条热窗口；会话内折叠后，「controller 当时看到了什么」与「盘上存了什么」出现第二套映射，排障时必须先重建这套映射。

### 8.3 Controller 引用已消失内容

- 模型对被移除内容的反应不是优雅降级：GSM-IC 显示单句无关信息即可 derail，而「引用了已不存在细节」的幻觉是压缩交接的已知风险——Deep Agentic Search（arxiv 2608.01507）发现 41.8% 的深度检索失败发生在 planner→subagent 交接处，且「通常是静默的，以流利而自信的错误答案收场」。
- 业界的统一缓解是**占位符而非静默删除**：Anthropic context editing「以占位符文本告知 Claude 内容已被移除」；SWE-agent "(n lines omitted)"；OpenAI trimmer "[Trimmed: ...]"。折叠实现必须沿用。
- Anthropic 官方警告原文："overly aggressive compaction can result in the loss of subtle but critical context"——并给出调参方向「先最大化召回」。

### 8.4 多 worker 分工依赖彼此轨迹

- Cognition 的失败模型全部建立在「部分视图下的并行 actor 做出冲突隐式决策」上；controller 折叠得越狠，它给后续 worker 的任务描述越依赖浓缩印象。
- MAST：inter-agent 失调 ~32%（推理-行动不一致 13.2%、任务脱轨 7.4%、忽略他方输入 1.9%）——折叠若切断了「worker A 的进展对 worker B 有信息价值」的通道，就往这个最大的失败桶里加料。
- Anthropic 2026 红队研究（anthropic.com/research/multiagent-systems）的 hidden-profile 实验：群体任务中「未共享的事实要么从未被主动提供、要么在共识形成后不再被追问」——折叠掉的跨项目信息**不会**通过「需要时再问」补回来。
- 防线：本系统 `read_worker_conversation`（分页、显式截断标记）是按需拉取全量的通道，折叠不得破坏；跨 worker 依赖的任务对（Cognition 场景）应显式携带规格而非依赖轨迹共享。

### 8.5 实现复杂度与新 bug 面

- 本系统 compaction 已有可观的语义复杂度：`compactStartIdx` 的三种含义（compact 后 / restore 后 / truncate 后各不相同）在 context-manager.ts 中需要长注释自证；折叠会再加一套「驻留形态 vs 存储形态」的映射。
- conversation-to-sdk-messages.ts 已经要为中断步骤合成孤儿工具结果（`[No result — step was interrupted]`）——消息层变换的边角问题在本系统有前科。
- token 估算器「对 CJK 与工具 JSON 低估」（代码注释自认），靠 `lastReportedTokens` 真实值兜底；折叠若依赖估算器触发，会继承这个偏差。
- 折叠规则本身是新的配置面：按类型？按 worker？按项目？每条规则都有边界情况（worker 重启、信号乱序、跨项目引用），每条都是新 bug 入口。这是「值得做」与「现在做」之间的主要成本。

### 8.6 反方证据的净评估

反方清单中，**8.1 是机制性成立的**（但可通过实现形态规避，见 3.5）；8.2/8.3/8.4 是概率性风险，业界已有标准缓解（占位符、按需拉取通道、错误保留）；8.5 是一次性工程成本。没有任何一条构成「折叠原则错误」的证据，但每一条都约束实现方式——这正是第 9 节建议的形态来源。

---

## 9. 结论与建议

### 9.1 对五个判断的裁决

| 判断 | 裁决 | 最关键依据 |
|---|---|---|
| A：折叠旧 signal 值得做 | **部分支持** | 收益机制实证存在且恰好对准本场景（Classifier Context Rot：监督者对 800K 良性历史的漏检率提高 2–30×；Chroma：连贯的无关叙述比随机噪声更伤——progress 流正是此类）；业界无一系统全文无限驻留高频事件。但优先级取决于 signal 实际占比，未测量；MAST 显示「丢历史」类失败仅 2.8%，下行风险非零。 |
| B：收益主要不来自省 token，而来自结构性无用信息不该入历史 | **部分支持** | 定价侧：缓存命中时被折叠内容只按 0.1× 计价，省钱的边际收益确实小；质量侧证据强（上表）。但「旧值必然被覆盖」只适用于 progress/heartbeat 类状态推进信号；completed/failed 是不可覆盖的终态事实，把「结构性无用」推广到全部信号不成立。 |
| C：改写会话前缀→缓存失效→可能净亏 | **支持（限定于中段改写实现）** | 机制完全确认：「命中要求 100% 逐字节一致」、messages 层任何变化使其后全失效、重写段付 1.25×。但入口折叠（append 形态）不触发；边界重建是有界损失、Anthropic 官方自己也这么做（clear_at_least / expected rebuild / idle compaction）。C 的正确读法是「折叠不得以任意中段改写实现」。 |
| D：上下文体积主因未必是 signal，需要先测量 | **支持** | 本系统 ContextBreakdown 把 signal 计入 user 组，现有仪表无法归因；controller 还有大量工具调用结果（别家系统恰恰最先清除的对象）；摘要器已剔除 heartbeat、队列层已覆盖未读 progress——signal 的净增量比直觉少。第一行动项就是给 breakdown 加 signals 分组。 |
| E：多项目并行下「按项目分区驻留 + 状态面板替代叙述流」是更根本解法 | **部分支持（方向成立；无直接先例）** | 交错失效实证强（GSM-IC 单句 derail 至 6% 宏准确率、NoisyBench 最高 80% 且含「无关聊天记录」类噪声、Anthropic 自家观察到 excessive updates 干扰、Boolean AI 观察到「坍缩进 prefill」）；分区先例充分（Letta 每块限额+预算可见、Mem0 命名空间+生命周期清理、MIRIX 分区路由）；「面板替代叙述流」有强先例（Manus todo.md 复诵、Chroma 聚焦输入优于全量、Fowler 快照与日志并存）。**但「按项目」分区无直接公开先例**，是有依据的拼装；且其实现复杂度显著高于折叠，面板自身也须小而稳定（Manus 复诵模式），否则面板成为新噪声源。 |

「更根本」的论证：折叠优化的是单一叙述流的驻留量；分区+面板改变的是信息组织形态——状态归状态存储、事件归日志、模型看派生视图。第 7.2 节的四层共识模式说明这是所有被核实系统的共同终点，折叠只是通往它的第一步（模式 3 的类型化省略）。

### 9.2 按信号类别的驻留建议

| 信号类别 | 是否驻留 | 驻留多久 | 折叠后留什么痕 |
|---|---|---|---|
| heartbeat | **不驻留**（不入会话；至多保留最近 1 条） | — | SignalState 窗口可查（query_signals）；controller 因 heartbeat 做出的任何动作（工具调用/回复）本身留在历史——决策即是痕 |
| progress | 驻留但**结构折叠**：每 worker 保留最近 1–2 条全文 | 被新值取代后，旧值在入口折叠为一行索引（sig-id + 时间 + 首行摘要）；更老的整行移除 | worker 的 conversation.jsonl 全文永在（分页工具）；SignalState 2000 条窗口可查；一行索引导航 |
| permission_request / worker_inquiry / inquiry_timeout | **全量驻留** | 会话生命周期，不折叠 | 不适用——阻塞型决策事件，审计关键，且必须与 respond 条目配对可查 |
| completed / failed / task_cancelled / worker_disposed（subtype） | **全量驻留** | 至少到预算兜底触发；预算折叠时最后动 | 终态事实不可被覆盖，优先保留全文；failed 额外保留（Manus：错误是证据） |
| input（用户消息） | **全量驻留** | 永不折叠 | 不适用 |
| message_undelivered / previous_session_tasks | 全量驻留 | 低频边界事件，不折叠 | 不适用 |

多项目维度（面向未来）：每项目一块带限额的分区（Letta block 式 `limit` + 预算可见），叙述流留在分区内；全局层只保留用户消息、全局规则、跨项目调度决策；一个持续再注入的「状态面板」（各项目/worker 当前状态的一屏快照）替代叙述流成为 controller 的常态输入——面板要小、稳定、末尾放置（CRE：末尾任务副本恢复中部精度 ±4pp；Manus：复诵进末尾）。

### 9.3 触发条件选项

| 方案 | 机制 | 优点 | 缺点 |
|---|---|---|---|
| 预算驱动 | token 阈值触发折叠/压缩 | 可预测、实现简单、与现有 isFull() 兼容 | 语义盲——等爆才动；阈值内的高频噪声照样伤害注意力（Chroma：退化远在窗口限额前） |
| 语义驱动 | 按类型/覆盖关系/新旧决定形态 | 精准及时（被覆盖即刻折叠）、不依赖阈值 | 规则面大、边界情况多（跨项目引用、worker 重启、乱序） |
| **混合（推荐）** | 语义规则第一道（入口处：heartbeat 不入会话、progress 一行化——append 形态，缓存安全）；预算第二道（触顶时 compaction 兜底，摘要调用做成 cache-safe fork） | 结构性无用信息根本不入史；兜底有界 | 两套机制都要维护 | 

该组合即 Claude Code（类型化清除 + auto-compact）与 Anthropic 官方（context editing + compaction）的现行形态，不是发明。

### 9.4 最小可验证实验设计

**前置（判断 D 的验证，先于一切）**：给 `ContextBreakdown` 加 signals 归因组；回放 3–5 个真实多 worker 长会话，测 signal（分 heartbeat/progress/其他）占上下文比例。若 signal 占比 <10%，A 的优先级让位于工具结果管理。

**A/B 设计**：
- 对照：现状（全量驻留 + 90% compaction）。
- 实验：入口折叠（heartbeat 不入会话；progress 每 worker 驻留最近 2 条全文，旧值一行索引；其余不变）。
- 任务集：固定的多 worker 编排任务（含长任务、permission 事件、一对跨 worker 依赖任务），信号序列 record & replay 固定，消除到达时序随机性。
- 次数：每组 N≥10——多轮论文的核心教训是退化以**方差**（+112%）为主，只看均值会漏掉。
- 混杂控制：同模型同温度；两组 compaction 次数分别统计（折叠应显著推迟/避免 compaction）；摘要 prompt 不变。

**指标**：
1. 质量：调度决策正确率（脚本化：误取消/重复派发/漏处理 permission 超时）；「引用不存在内容」幻觉率（引用已折叠 signal 的细节）。
2. 稳定性：同任务多次运行的决策方差。
3. 成本：每回合 input tokens、cache read/write 比、每任务总费用。
4. 延迟：TTFT、回合时长。

**判读**：质量与稳定性非劣效 + 成本/延迟显著改善 → 支持落地；质量下降 → 按 8.3/8.4 排查（哪类信号被过度折叠、占位符是否缺失、依赖任务对是否需要显式规格）。

---

## 10. 来源清单与方法说明

### 10.1 方法说明

- 联网访问成功。除标注外，所有外部结论来自 2026-11-03 实际抓取的页面；代码事实来自对本仓库 `src/` 的直接阅读。
- **搜索引擎返回的 arXiv ID 不可靠**：本次调研中多次出现搜索摘要给出的 ID 与论文实际内容不符（如 2505.05926 被传是多 agent 失败分类学论文、实际是增量学习论文；2407.14926 被传是 LOFT、实际是路径规划论文；多个「Beyond the Needle」ID 实际是量子物理/密码学论文）。本报告所有 arXiv 引用均逐一抓取核验过，读者引用时建议同样处理。
- 两位调研者对 Manus 与 Anthropic 核心页面的独立抓取结果一致（交叉验证）。

### 10.2 已核实来源（按主题）

**长上下文退化（第 2 节）**
1. Lost in the Middle: How Language Models Use Long Contexts — https://arxiv.org/abs/2307.03172
2. Context Rot: The Effect of Context on Reasoning and Fact Recall in LLMs（Chroma） — https://www.trychroma.com/research/context-rot
3. NoLiMa: Long-Context Evaluation Beyond Literal Matching — https://arxiv.org/abs/2502.05167
4. RULER: What's the Real Context Size of Your Long Context Language Models? — https://arxiv.org/abs/2404.06654
5. LLMs Get Lost in Multi-Turn Conversation — https://arxiv.org/abs/2505.06120
6. Reasoning on Multiple Needles In A Haystack — https://arxiv.org/abs/2504.04150
7. DISCO: Distributed Long Context Scaling with Grounding-Reasoning Disaggregation — https://arxiv.org/abs/2609.33485
8. Classifier Context Rot: Monitor Performance Degrades with Context Length — https://arxiv.org/abs/2605.12366
9. When and How Context Rot Appears in Coding Agents — https://arxiv.org/abs/2607.17937
10. Context Rot Quantified（Boolean AI，2 模型博客研究，仅定性参考） — https://boolean.ai/blog/context-rot-quantified
11. Many-Shot In-Context Learning — https://arxiv.org/abs/2404.11018
12. Positional Failures in Long-Context LLMs（CRE） — https://arxiv.org/abs/2605.23170

**Prompt cache 与官方机制（第 3 节）**
13. Anthropic Prompt Caching 文档 — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
14. Anthropic Context Editing 文档 — https://platform.claude.com/docs/en/build-with-claude/context-editing
15. Anthropic Memory Tool 文档 — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
16. Anthropic Compaction 文档 — https://platform.claude.com/docs/en/build-with-claude/compaction
17. Anthropic 定价页 — https://platform.claude.com/docs/en/about-claude/pricing；上下文窗口页 — https://platform.claude.com/docs/en/build-with-claude/context-windows
18. Prompt caching 发布公告（Anthropic，含 TTFT 实测） — https://claude.com/blog/prompt-caching
19. Lessons from building Claude Code: Prompt caching is everything — https://claude.dev/blog/lessons-from-building-claude-code-prompt-caching-is-everything/
20. Claude Code: How Claude Code uses prompt caching — https://code.claude.com/docs/en/prompt-caching；costs — https://code.claude.com/docs/en/costs；context-window — https://code.claude.com/docs/en/context-window；model-config — https://code.claude.com/docs/en/model-config；CHANGELOG — https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
21. Azure OpenAI Prompt Caching（含 "Keep conversation context append-only" 最佳实践） — https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/prompt-caching
22. Gemini Context Caching — https://aistudio.google.com/docs/caching；定价 — https://aistudio.google.com/docs/pricing
23. DeepSeek Context Caching — https://api-docs.deepseek.com/guides/kv_cache
24. Manus: Context Engineering for AI Agents — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

**多 agent 争论（第 4 节）**
25. Cognition: Don't Build Multi-Agents — https://cognition.com/blog/dont-build-multi-agents
26. Anthropic: How we built our multi-agent research system — https://www.anthropic.com/engineering/built-multi-agent-research-system
27. Anthropic: Effective context engineering for AI agents — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
28. MAST: Why Do Multi-Agent LLM Systems Fail? — https://arxiv.org/abs/2503.13657
29. AgentPrune: Cut the Crap — https://arxiv.org/abs/2410.02506
30. RE-TRAC: Recursive Trajectory Compression for Deep Search Agents — https://arxiv.org/abs/2602.02486
31. Manus: Wide Research: Beyond the Context Window — https://manus.im/blog/manus-wide-research-solve-context-problem
32. Anthropic: Patterns and problems in emerging multiagent systems — https://www.anthropic.com/research/multiagent-systems
33. Deep Agentic Search for Repository-Level Code QA — https://arxiv.org/abs/2608.01507

**多项目维度（第 5 节）**
34. GSM-IC: Large Language Models Can Be Easily Distracted by Irrelevant Context — https://arxiv.org/abs/2302.00093
35. NoisyBench: Lost in the Noise — https://arxiv.org/abs/2601.07226
36. Letta: Conversations — https://www.letta.com/blog/conversations；Memory Blocks — https://www.letta.com/blog/memory-blocks 与 https://docs.letta.com/v1-sdk/memory/memory-blocks/；Anatomy of a Context Window — https://www.letta.com/blog/guide-to-context-engineering
37. MIRIX: Multi-Agent Memory System — https://arxiv.org/abs/2507.07957
38. Mem0 Entity-Scoped Memory — https://docs.mem0.ai/platform/features/entity-scoped-memory
39. GCC: Manage the Context of LLM-based Agents like Git — https://arxiv.org/abs/2508.00031
40. MemPrice: Online Memory Allocation via Adaptive Pricing — https://arxiv.org/abs/2610.24955
41. Wikipedia: Interrupt coalescing — https://en.wikipedia.org/wiki/Interrupt_coalescing；MDN requestAnimationFrame — https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame；Chrome Timer throttling — https://developer.chrome.com/blog/timer-throttling-in-chrome-88
42. Claude Code Subagents — https://code.claude.com/docs/en/sub-agents；Interactive mode（消息队列） — https://code.claude.com/docs/en/interactive-mode
43. LangGraph Human-in-the-loop — https://docs.langchain.com/oss/python/langgraph/human-in-the-loop；OpenAI Agents SDK HITL — https://openai.github.io/openai-agents-python/human_in_the_loop/；AutoGen HITL — https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/human-in-the-loop.html

**成本与延迟（第 6 节）**
44. Splitwise — https://arxiv.org/abs/2311.18677
45. MInference 1.0 — https://arxiv.org/abs/2407.02490
46. Transformer Inference Arithmetic — https://kipp.ly/blog/transformer-inference-arithmetic/
47. Quest — https://arxiv.org/html/2406.10774
48. vLLM/PagedAttention — https://arxiv.org/abs/2309.06180
49. Longformer — https://arxiv.org/abs/2004.05150
50. Gemini 1.5 技术报告 — https://arxiv.org/abs/2403.05530；Llama 4 model card — https://raw.githubusercontent.com/meta-llama/llama-models/main/models/llama4/MODEL_CARD.md；Simon Willison: Llama 4 notes — https://simonwillison.net/2025/Apr/5/llama-4-notes/
51. Claude Sonnet 4.5 发布 — https://claude.com/blog/claude-sonnet-4-5
52. OpenAI 定价（经代理抓取） — https://platform.openai.com/docs/pricing

**事件流处理（第 7 节）**
53. OpenHands Context Condenser — https://docs.openhands.dev/sdk/guides/context-condenser.md；Condenser architecture — https://docs.openhands.dev/sdk/arch/condenser.md；Persistent memory — https://docs.openhands.dev/sdk/guides/persistent-memory.md
54. SWE-agent History Processors — https://swe-agent.com/latest/reference/history_processor_config/
55. OpenAI Agents SDK Sessions — https://openai.github.io/openai-agents-python/sessions/；Tool Output Trimmer — https://openai.github.io/openai-agents-python/ref/extensions/tool_output_trimmer/
56. LangGraph Persistence — https://docs.langchain.com/oss/python/langgraph/persistence
57. MemGPT — https://arxiv.org/abs/2310.08560；Letta 现行文档 — https://docs.letta.com/
58. Context-Folding — https://arxiv.org/abs/2510.11967；Solving Context Window Overflow — https://arxiv.org/abs/2511.22729
59. Martin Fowler: Event Sourcing — https://martinfowler.com/eaaDev/EventSourcing.html；What do you mean by "Event-Driven"? — https://martinfowler.com/articles/201701-event-driven.html

### 10.3 未能核实、不作为论据的内容（诚实清单）

- OpenAI 平台页直连 403（定价经 r.jina.ai 代理抓取到，但 Short/Long 上下文切换的具体费率未捕获）；OpenAI 帮助中心的缓存折扣百分比未核实。
- GPT-4.1 发布页（RULER 74.8%@128K 的反方数据点）403，未能核实。
- 「Beyond the Needle」「FABLE」「Needle in a Noisy Haystack」「LOFT」等论文：多次检索未找到可核实的原文，疑似记忆讹传或标题有误，全部弃用。
- MIRIX 的 Deep Memory Console 分数、Manus 的「H2A/A2H」文章、Peak Ji 的相关推文：仅见于搜索摘要，未抓到原文，弃用。
- Claude Code 的「/microcompact 命令」：在命令参考、context-window 页与完整 CHANGELOG 中均不存在该词；对应行为以「工具结果清除」形式存在（见来源 20）。
- Chroma 报告的逐模型分数仅以图呈现，无文本数字；流传的「o3 −55%」等具体数字未核实，本报告未使用。
- Wayang 侧未做任何运行时测量（本报告为纯调研），第 1 节数字均来自代码常量而非生产统计。

