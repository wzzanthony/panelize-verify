# Panelize Verify

在 [Panelize](https://github.com/Manho/Panelize)（v2.2.4）上做的二次开发：同一个 Prompt 发给两个 LLM 并排回答 →
**用户先独立投票** → 再揭示 Gemini 基于 Google Search Grounding 的陈述级事实核查和**匿名**比较结论。

保留了 Panelize 原有的全部功能。上游原版说明见 [PANELIZE_README.md](PANELIZE_README.md)。

---

## 1. 安装（本地，未打包）

1. Chrome 打开 `chrome://extensions`，打开右上角「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录（含 `manifest.json` 的那一层）。
3. 点工具栏的 Panelize 图标（或 `Ctrl+Shift+E`）打开多面板页。
4. 确保前两个面板是要比较的模型（默认示例：ChatGPT、Claude），并在面板里**登录**各自网站。

需要 zip 包时：`npm ci && npm run release:package`（沿用 Panelize 的打包脚本，新增文件已自动包含）。

## 2. 配置 Gemini API Key（BYOK）

1. 到 Google AI Studio 申请 API Key。**注意：** Search Grounding 在 Gemini 3.x Flash / Flash-Lite 的免费层（未绑定结算账号）上标为 "Not available"，
   所以这个 Key 所在的项目必须绑定结算账号。绑定后每月前 5000 次搜索免费，token 按付费层计价（2026-11 查阅官方价格页）。
2. 多面板页底部 **Verify** 面板 → 右侧 ⚙ → 粘贴 Key。
3. 勾选数据发送确认：「验证会把 Prompt 和两个回答的文本发送到 Google Gemini API」。**不勾选就不会发送任何内容。**
4. 「Gemini model ID」可改，默认 `gemini-3.5-flash-lite`（官方模型页上的稳定版，支持 Search Grounding）。
   模型 ID 只存在配置里，没有写死在代码中。
5. 点「Test key & model」：只调用 `models.get` 检查 Key 和模型 ID，不产生生成费用。

Key 的存放位置：扩展自身 origin 的 IndexedDB（`PanelizeVerifyDB`）。content script 运行在网页 origin，读不到它；
网页脚本也读不到。Key 不写日志、不进导出文件、只放在请求头 `x-goog-api-key` 里（不进 URL）。

## 3. 使用流程

1. 在底部输入框输入问题 →「Send All」。
2. Verify 面板显示 `A · ChatGPT generating…` / `B · Claude captured` 等状态；两个回答都**流式结束且文本稳定**后自动抓取。
3. **Human Preference Voting**：选 A / B / Tie（可写理由）→ Submit Vote；或 Skip voting（记录为 `SKIPPED`，不当作平局）。
4. Gemini 可能已在后台跑完，但投票前只显示一句不带任何倾向的提示「Results are hidden until you submit or skip your vote」。
5. 投票保存成功后才揭示：
   - **A. Fact Verification**：每个回答的 Supported / Contradicted / Insufficient evidence / Not verifiable 计数和逐条陈述（可展开看解释、来源链接）。
   - **B. Gemini's Final Decision**：A / B / Tie / Uncertain + 理由 + 五项评分。
   - **C. Human vs AI**：Agree / Disagree / Partial（一方选 Tie）/ Gemini uncertain / No human vote，及分歧原因。
   - Google 要求展示的 **Search Suggestions**（在禁用脚本的 sandbox iframe 中渲染）。
6. 揭示后想改主意：「Changed your mind?」记录为 post-reveal feedback，原始投票不变。
7. **History**：历史记录、人机一致率统计、按模型的 Gemini 胜出次数、**Export JSON**。

后备入口：
- **Capture now**：立即读取两个面板当前最新回复（例如你直接在面板里打字发送、或带图片发送时 Panelize 只填不发）。
- **Paste**：手动粘贴 Prompt 和两个回答（provider 不支持自动抓取或抓错时用）。

---

## 4. 仓库评估（Milestone 1）

| 方面 | Panelize 现状（读源码确认） | 处理 |
|---|---|---|
| 技术栈 | 纯 JS ES Modules，**无构建步骤**；vitest + happy-dom 单测；Playwright e2e | 沿用。类型用 JSDoc 写，`npm run typecheck` 由 `tsc --checkJs` 校验 |
| 多面板 | `multi-panel/` 用 iframe 嵌入各网站，`declarativeNetRequest` 去掉 frame 限制头 | 复用 |
| Prompt 同步 | `broadcastMessage → sendToPanel → postToPanelFrame`，按 provider origin 定向 `postMessage` | 复用；只加了发送前/后两个钩子 |
| 消息安全 | content script 用 `isFromMultiPanelHost` 校验 origin + `event.source`；回传只发给扩展 origin | 新 content script 用同一套规则；宿主侧用现成的 `findMessageSourcePanel` 校验来源 iframe 和 origin |
| **回答抓取** | **没有**。只有截图式 snapshot；忙闲检测也只覆盖 ChatGPT / AI Studio | 新增 AnswerExtractor（Adapter）+ CompletionDetector |
| 存储 | `chrome.storage` 存设置；自定义 API 的 Key 存扩展 IndexedDB | 同样做法 |
| API Provider | 有 OpenAI 兼容客户端（给自定义 API 面板用） | 不复用；Gemini 单独封装 |

### 新增文件

| 文件 | 作用 |
|---|---|
| `content-scripts/answer-extractor.js` | 只读的回答抓取。Provider Adapter（ChatGPT / Claude / Gemini）+ MessageNormalizer（DOM→Markdown：标题、列表、代码块、表格、KaTeX）。只读最后一个用户轮次之后的回复 |
| `modules/verify/completion-detector.js` | 完成判定：用户轮次比发送前新、与 Prompt 匹配、没有停止按钮、文本 2.5 秒不变 |
| `modules/verify/session-state.js` | 评估会话状态机；**人类优先**的规则全在这里（揭示门控、投票锁定、post-reveal feedback） |
| `modules/verify/anonymizer.js` | A/B→X/Y 随机映射（`crypto.getRandomValues`）、裁决映射回 A/B、模型自称屏蔽 |
| `modules/verify/gemini-client.js` | Gemini REST 客户端：超时、取消、重试（仅 429/5xx/网络）、错误分类、Key 脱敏 |
| `modules/verify/grounding.js` | `parseGroundingMetadata`、证据 URL 校验、按 UTF-8 字节区间把来源挂到具体陈述 |
| `modules/verify/schema.js` | 模型输出校验（`validateOutput`）；去重、限量；剥离模型自写的 URL |
| `modules/verify/prompts.js` | 三步的系统指令（基于规格 §5，加了不可信输入隔离） |
| `modules/verify/verification-service.js` | `GeminiVerificationService`：`extractClaims` / `verifyClaims` / `compareAnswers` / `evaluate` |
| `modules/verify/agreement.js` | 人机一致性判定与统计 |
| `modules/verify/storage.js` | IndexedDB 会话与 Key、设置、JSON 导出 |
| `modules/verify/types.js` | 规格 §6 的数据结构（JSDoc 版） |
| `multi-panel/verify-dock.js` / `.css` | Verify 面板 UI 与流程编排 |

### 修改的原有文件

- `multi-panel/multi-panel.js`：+2 个 import、`setupVerifyDock()`、`broadcastMessage` 里发送前后各一行钩子。
- `multi-panel/multi-panel.html`：工具栏 Verify 按钮、`#verify-dock` 容器、标题。
- `manifest.json`：ChatGPT / Claude / Gemini 的 content script 列表加 `answer-extractor.js`；host 权限只加了 `https://generativelanguage.googleapis.com/*`；`short_name`。
- `_locales/*/messages.json`：扩展名改为 `Panelize Verify - …`。
- `tests/store-listing-locales.test.js`：`short_name` 断言随改名更新。
- `package.json`：`typecheck`、`test:verify`、`test:e2e:verify` 脚本；devDependency `typescript`。

---

## 5. 验证流水线

一次比较 = 3 次 `generateContent` 调用（`POST /v1beta/models/{model}:generateContent`）：

1. **抽取陈述**（JSON 输出，不搜索）：从匿名的 Answer X / Y 中抽出可独立核查的陈述，合并语义等价项（标注出现在 X、Y 或两者），意见/建议标 `verifiable:false`。每个回答最多 N 条（默认 8）。
2. **核查**（开启 `googleSearch` 工具，纯文本分节输出）：只发送可核查陈述（不发送两个回答原文），所有陈述合并成**一次**带搜索的请求。
3. **盲审**（JSON 输出，不搜索）：Prompt + 匿名 X/Y + 核查结果 → `X | Y | TIE | UNCERTAIN` + 理由 + 五项 1–5 分。

防编造规则（代码强制，不依赖模型自觉）：

- 证据链接**只**取自 `groundingMetadata.groundingChunks`；模型在正文里写的 URL 一律删除，不显示为链接。
- 每条陈述的证据 = 与该陈述那一节字节区间重叠的 `groundingSupports` 指向的 chunk。
- 模型说 SUPPORTED / CONTRADICTED 但该节**没有挂上任何来源** → 降级为 `INSUFFICIENT_EVIDENCE`，并保留模型原始标签供查看。
- 整个核查请求一个来源都没有 → 报错 `SEARCH_UNAVAILABLE`，**不跑盲审，不产生任何结论**。
- 无法识别的状态 → `INSUFFICIENT_EVIDENCE`；裁决不在枚举内 → 报错，不猜。
- `publishedAt` / `snippet`：grounding 不提供，就留空，不编造。

盲评：

- 请求中不含模型名、provider id、A/B 标签、用户投票。可选（默认开）把两个被比较模型的自称（如 "As ChatGPT…"、"Claude"、"GPT-4o"）替换为 `[an AI assistant]`；若用户的 Prompt 本身提到该名字（话题而非签名），则保留。
- X/Y 顺序每个会话随机，映射只存本地。

费用控制：每会话同时只允许一个运行中的验证（防重复点击重复计费）；已完成的会话重跑需确认；超时不自动重试（慢请求可能已计费）；限制每个回答的陈述数与字符数；揭示区显示调用次数、搜索次数、token 数。

---

## 6. 测试

```bash
npm ci
npm test                 # 全部单测（含原有 1285 个）
npm run test:verify      # 只跑 Verify 相关单测
npm run typecheck        # tsc --checkJs 校验 Verify 模块
npx playwright install chromium
npm run test:e2e:verify  # 真实 Chromium 加载扩展的端到端流程
```

| 验收标准 | 覆盖方式 |
|---|---|
| Test 1 并行生成 | Panelize 原有 e2e + `verify-flow.e2e` 中两个仿真页面各自流式回答 |
| Test 2 回答抓取 | `verify-answer-extractor.test.js`（历史轮次、流式中、思考块、Markdown 结构）；e2e 断言抓到的文本完整且不含上一轮 |
| Test 3 人类优先 | `verify-dock.test.js`：Gemini 已完成时页面上没有结论/计数/颜色/iframe；e2e 同样断言 |
| Test 4 盲评 | `verify-gemini.test.js` 检查三个请求体无模型名/投票；e2e 截获真实请求再查一遍；Key 只在请求头 |
| Test 5 事实核查 | 模拟 grounding 响应：支持 / 反驳 / 无来源降级 / 证据不足 / 不可核查 五种情况 |
| Test 6 人机对比 | 8 种组合，Tie 与 Uncertain 单独处理 |
| Test 7 API 失败 | 无效 Key（且错误信息不含 Key）、429 重试后报额度、超时、断网、安全拦截、搜索无证据；失败时仍可投票、回答照常显示 |
| Test 8 持久化 | 重建 dock 后恢复会话且仍隐藏结果；e2e 刷新页面后恢复已揭示会话 |
| Test 9 隐私 | 只读最后一轮；未同意不发送；请求体内容由 Test 4 的断言覆盖。**真实网络抓包未做**，见下文 |
| Test 10 构建 | 真实 Chromium 加载 MV3 扩展、页面无 JS 报错；仓库全部 e2e 通过。`npm run lint`（web-ext，面向 Firefox）在原版就有 8 个错误，本改动未新增错误，只多 1 个测试文件里 `eval` 的警告 |

---

## 7. 已知限制与设计取舍（请务必看）

1. **没有在真实的 chatgpt.com / claude.ai 上测过。** 抓取用的 DOM 选择器依据这些网站公开的页面结构（`data-message-author-role`、`data-is-streaming`、`model-response` 等），已在仿真页面和真实 Chromium 中验证流程，但网站改版会让选择器失效。失效时状态会停在 waiting/unsupported，可用 **Capture now** 或 **Paste**。选择器集中在 `answer-extractor.js` 顶部的 `ADAPTERS`，修起来只改一处。自动抓取目前支持 ChatGPT、Claude、Gemini；其他 provider 走 Paste。
2. **没有用真实 Gemini API Key 调用过。** 请求格式按官方 REST 参考（`generateContent`、`tools: [{googleSearch: {}}]`、`groundingMetadata` 字段）编写，测试中用模拟响应。官方文档目前主推新的 Interactions API，`generateContent` 仍在参考文档中、未标弃用。**首次使用请先点「Test key & model」，再拿一个已知答案的问题试一次。**
3. 结构化 JSON 输出与 Google Search 工具能否在同一请求中同时使用，文档表述不确定，所以核查步骤用「分节纯文本 + 本地解析」，另外两步用 JSON 模式。
4. **Google 条款**：Grounding 结果必须连同 Search Suggestions 一起展示给提问的用户（已实现）；条款还限制「修改或穿插」Grounded Results、缓存与点击追踪，并对存储设了例外条件（最长两年）。本插件把结果按陈述重组展示并在本地保存，适合个人研究使用；**若要公开发布，需重新评估是否符合条款**，并按规格考虑后端代理。
5. 规格要求 TypeScript；Panelize 没有构建步骤，为了不引入打包链，用 JSDoc 类型 + `tsc --checkJs` 代替。
6. 布局：保留 Panelize 原有的底部输入栏，Verify 面板放在回答面板与输入栏之间；面板内顺序为 回答 → 投票 → Gemini，满足「评分区在 Gemini 结果之前」。
7. 只比较**前两个**面板（A = 第一个，B = 第二个）；超过两个会提示。
8. 多轮对话：每次 Send All 是一个新会话，只核查该轮回答；不做跨轮上下文核查（P1）。
9. 证据链接通常是 Google 的跳转地址（`vertexaisearch.cloud.google.com/...`），标题一般是来源域名；grounding 不给发布日期和原文摘录，界面显示的是「Gemini 引用该来源的那句话」。
10. 模型身份屏蔽是基于名字列表的启发式，无法覆盖所有间接线索（例如写作风格）。
11. 计费：一次比较 3 次模型调用；Gemini 3 及以上按模型实际执行的每次搜索计费（2026-11 查阅官方文档时：每月 5000 次免费，之后每 1000 次 $14），以官方最新价格为准。
12. Test 9 的「网络请求检查」只在测试中通过拦截请求完成，没有在真实浏览器里用 DevTools 抓包核对。

### 尚未实现

- P1：自动检测需要重新验证的回答、多轮上下文验证。（历史、JSON 导出、一致率统计、失败重试、搜索/调用计数已做。）
- P2：在原回答中高亮错误陈述、双向顺序审核、多次采样 / 多 Judge、位置偏差检测、有无 Grounding 对比等均未做。
