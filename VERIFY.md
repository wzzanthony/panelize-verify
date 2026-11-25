# Panelize Verify

在 [Panelize](https://github.com/Manho/Panelize)（v2.2.4）上做的二次开发：同一个 Prompt 发给两个 LLM 并排回答 →
**用户先独立投票** → 再揭示 Gemini 基于 Google Search Grounding 的陈述级事实核查和**匿名**比较结论。

保留了 Panelize 原有的全部功能。上游原版说明见 [PANELIZE_README.md](PANELIZE_README.md)。

---

## 1. 安装（本地，未打包）

完整步骤和常见报错见 [README.md 的"安装"一节](README.md#安装)。要点：

1. 下载 zip 后先解压，然后在 `chrome://extensions` 打开开发者模式，点「加载已解压的扩展程序」，选**直接包含 `manifest.json` 的文件夹**。注意 Windows 解压常多套一层。
2. 不要用「打包扩展程序」：自己打包的 `.crx` 普通 Chrome 不让装。
3. 点工具栏的扩展图标（或 `Ctrl+Shift+E`）打开多面板页，前两个面板放要比较的模型（例如 ChatGPT、Claude）并登录。
4. 更新时覆盖原文件夹，再点扩展卡片上的刷新按钮 ⟳。换路径或移除扩展会丢失本地历史和 Key。

只想要运行所需文件（不含测试和文档、体积更小）时，可以用 Panelize 原有的打包脚本：`npm ci && npm run release:package`。生成的 `dist/release-<版本>/panelize-<版本>-release.zip` 里没有外层文件夹，要解压到一个新建的空文件夹，再用「加载已解压的扩展程序」选这个文件夹。

---

## 2. 选择 Gemini 的工作方式（设置里切换）

Verify 面板 → 右侧 ⚙ → 「How Gemini checks the answers」：

| | 网页模式（默认） | API 模式 |
|---|---|---|
| 怎么调用 | 答案面板下方的「Gemini verifier」面板里打开 gemini.google.com，用你的 Google 登录，和 Panelize 其他面板一样 | Gemini API + Google Search Grounding |
| 需要什么 | 在这个浏览器里登录过 Gemini | API Key，且 Key 所在项目绑定结算账号 |
| 费用 | 不计费 | 每月 5000 次搜索免费，之后按次计费 |
| 来源可靠性 | 较弱：来源是 Gemini 在回答里写的链接，只有同时出现在 Gemini 页面引用里的才算数 | 较强：来源来自结构化的 groundingMetadata |
| 对话记录 | 尽量开启 Gemini 临时对话；开不了会进你的 Gemini 历史（界面会提示） | Google 保留最多 30 天 |
| 用量显示 | 无 token/搜索次数 | 调用次数、搜索次数、token |

两种模式各有一个数据发送确认，**不勾选对应确认就不会发送任何内容**。

### 2a. 网页模式

1. 先在 Chrome 里打开一次 https://gemini.google.com 并登录。
2. 底部 Verify 状态栏会显示「首次使用需确认」。点 **允许 Gemini 验证**，只需一次。也可以到设置里勾选同一项。
3. 布局：
   - **面板网格**：显示各个 AI 的回答。只要另外开着两个面板，网格里的 Gemini 就不收 Send All，也不算 A/B。
   - **Verify 状态栏**（网格下方一行）：
     - 版本序号 `Build N`；
     - A / B 抓取状态，鼠标悬停可以看抓取诊断；
     - Gemini 验证状态；
     - 「立即抓取」（抓取进行中才显示）、「移除网格中的 Gemini」、「打开 Verify」、设置。
   - **Gemini 页面缩略图**（状态栏最右）：Gemini 实际在这里的 iframe 中工作。Chrome 会限速被隐藏的跨域 iframe，所以页面保持渲染，只是缩小显示，并且**投票前一直遮住**。投票后点它可以放大查看，放大不会重新加载页面。
   - **Verify 窗口**：点「打开 Verify」会打开一个独立的浏览器小窗口，可以拖到另一块屏幕。里面依次是回答、投票，以及投票后的结果和 Gemini 验收报告全文。
     - 它显示的就是多面板页自己的 Verify 视图：两个页面同属扩展源，可以直接共享 DOM，不复制数据，也不发送到任何地方。
     - 关掉小窗不影响后台验证。
     - 浏览器拦截新窗口时，改为页面内可拖动、可缩放的小窗。
4. 每次比较都会自动验证，不需要手动点：缩略图里打开一个新的 Gemini 对话（尽量开临时对话），发送验收消息。完成后状态栏按钮闪烁，并弹出提示，但不会透露 Gemini 倾向哪个回答。
5. 超时默认 300 秒，可在设置里改（60–900）。

### 验收模板（网页模式）

发给 Gemini 的消息 = **验收模板** + 固定的输出格式 + 问题和两个匿名回答。默认模板（`modules/verify/acceptance-template.js`）：

- **角色**：Gemini 扮演独立的专业验收团队：事实核查员、逻辑审查员、首席验收官。
- **第一步 事实核查**：把回答拆成可独立核查的最小事实单元，改写成自包含的句子；对每条先提核查问题、再用 Google 搜索**独立**查证（不照着回答的措辞找支持证据）；给出 SUPPORTED / CONTRADICTED / INSUFFICIENT_EVIDENCE，只写实际用到的网址。
- **第二步 逻辑审查**：答非所问、推理跳步/偷换概念/以偏概全/因果倒置/循环论证、计算与单位错误、自相矛盾、未说明的假设；每个问题摘录原文、标严重程度。
- **第三步 验收结论**：事实准确性、证据支撑、逻辑严密性、完整性、相关性各 1–5 分；严重程度重于数量；不因篇幅、语气、排版、先后顺序加分；结论 X / Y / TIE / UNCERTAIN。

设计依据：事实拆分与逐条搜索核查参考 SAFE（Wei et al. 2024）和 FActScore（Min et al. 2023）；「先提问再独立查证」参考 Chain-of-Verification 的 factored 变体（Dhuliawala et al. 2023）；逻辑错误类型参考 ROSCOE（Golovneva et al. 2023）；去除位置、长度、风格偏差参考 MT-Bench 的 LLM-as-a-judge 研究（Zheng et al. 2023）。

模板可以在 Verify 设置里直接改（「Acceptance template」文本框，「Restore default template」恢复默认）。输出格式部分不在文本框里、始终自动附加，所以改模板不会让结果解析失败。API 模式仍用原来的三步流程，不使用这个模板。

### 2b. API 模式（BYOK）

1. 到 Google AI Studio 申请 API Key。**注意：** Search Grounding 在 Gemini 3.x Flash / Flash-Lite 的免费层（未绑定结算账号）上标为 "Not available"，
   所以这个 Key 所在的项目必须绑定结算账号。绑定后每月前 5000 次搜索免费，token 按付费层计价（2026-11 查阅官方价格页）。
2. 设置里选「API mode」，粘贴 Key。
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
| `modules/verify/completion-detector.js` | 完成判定：用户轮次比发送前新、与 Prompt 匹配（忽略 Markdown 符号）、没有停止按钮、文本 2.5 秒不变。兜底规则：页面上找不到用户轮次时，最新回答相对发送前有变化就算新回答；「停止」按钮一直不消失但文本 20 秒没变，也算完成 |
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
| `multi-panel/verify-dock.js` / `.css` | Verify 状态栏、Verify 窗口与流程编排 |
| `multi-panel/verify-window.html` | 独立 Verify 窗口的空壳页面：不含脚本，由多面板页把 Verify 视图放进去 |
| `scripts/bump-verify-build.mjs` | `npm run bump:build`：把 manifest 的 `version_name` 序号加 1（状态栏显示的 `Build N`），每次更新前运行 |

### 修改的原有文件

- `multi-panel/multi-panel.js`：+2 个 import、`setupVerifyDock()`、`broadcastMessage` 里发送前后各一行钩子；网页模式下 Send All / 触发发送跳过 Gemini 验证者面板。
- `multi-panel/multi-panel.html`：工具栏 Verify 按钮、`#verify-region`（`#verify-bar` 状态栏 + `#verify-judge-pane` 缩略图）、`#verify-dock`（Verify 窗口）、标题。
- `content-scripts/text-injection-all-providers.js`：Claude 自动发送改为带重试与「输入框已清空」确认（见第 7 节第 16 条）。
- `manifest.json`：ChatGPT / Claude / Gemini 的 content script 列表加 `answer-extractor.js`；host 权限只加了 `https://generativelanguage.googleapis.com/*`；`short_name`。
- `_locales/*/messages.json`：扩展名改为 `Panelize Verify - …`。
- `tests/store-listing-locales.test.js`：`short_name` 断言随改名更新。
- `package.json`：`typecheck`、`test:verify`、`test:e2e:verify` 脚本；devDependency `typescript`。

---

## 5. 验证流水线

### 网页模式

一次比较 = 在 gemini.google.com 上发**一条**消息（`modules/verify/web-judge.js` 组装，`multi-panel/verify-web-runner.js` 发送和读取）：

1. verifier 面板加载新的 `https://gemini.google.com/app`（首次且未用过的页面直接使用），等 Panelize 的 content script 就绪；
   发 `ENABLE_TEMP_CHAT`（Panelize 原有的临时对话机制），等页面确认。
2. 用 Panelize 原有的 `INJECT_TEXT` 把消息填进输入框并发送。消息 = 验收模板 + 输出格式 + Prompt + 匿名 X/Y 回答；要求先写给人看的验收报告，最后附一个 JSON 代码块（事实、逻辑审查、结论、评分）。
3. 用和 A/B 面板同样的完成判定（新的用户轮、无停止按钮、文本稳定 4 秒）读取回答，同时读取 Gemini 页面在这条回答里渲染的所有链接（不含代码块）。
4. 本地校验：
   - JSON 结构、裁决枚举、1–5 分，和 API 模式共用校验函数；
   - 来源网址先做安全检查（只允许 http/https），再与页面链接比对（会展开 `google.com/url?q=` 跳转、去掉 `utm_*`）。**只有比对上的才算「已确认」来源**，其余显示为 unconfirmed；
   - 模型说 SUPPORTED / CONTRADICTED 但没有任何已确认来源 → 降级为 `INSUFFICIENT_EVIDENCE`；页面上一个链接都没读到 → 所有陈述都不算已核实，并给出警告。
5. 20 秒内没出现新的用户轮会重发一次；再失败报「请确认已登录 gemini.google.com」。页面没加载起来（例如落到错误页）会自动重载一次。
6. 逻辑审查按回答解析为 SOUND / MINOR_ISSUES / FLAWED 加问题列表；标了 high 严重度却写 SOUND 的，改为 FLAWED。

投票前隐藏、盲评（不含模型名、投票）、X/Y 随机，和 API 模式完全相同。

### API 模式

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
npx vitest run           # 全部单测（含原有 1285 个）
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
| 网页模式 | `verify-web-mode.test.js`：消息不含模型名/投票、来源比对与降级、X/Y 映射、无 JSON 报错、隐藏面板的临时对话/重发/超时/取消、dock 不需要 Key 且投票前隐藏；`verify-flow.e2e` 第二个用例在真实 Chromium 中用仿真 gemini.google.com 跑完整流程，断言没有任何 API 请求 |
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

13. **网页模式没有在真实 gemini.google.com 上测过。** 用的是 Panelize 现有的 Gemini 输入框、发送按钮和临时对话按钮选择器，回答读取用 `model-response`；
    Gemini 页面上引用链接的真实结构未知——如果读不到，所有陈述都会显示为「证据不足」（裁决照常给出），界面会提示。
    消息较长（两份回答各最多 12000 字符），Gemini 网页输入框若有长度上限，可在设置里调小「Max characters per answer」。
14. 网页模式下 Gemini 是否真的搜索由它自己决定，扩展无法强制；也拿不到搜索次数和 token 用量。
15. 网页模式同一时间只跑一个核查；另一个比较需要等它结束。

16. Claude 的 Send All：Panelize 原本只在填字 0.5 秒后点一次发送按钮，问题常停在输入框里。原因之一是它的备用选择器 `fieldset button:has(svg)` 会点中输入框左边的「+」按钮，并误以为已经发出。现在只认真正的发送按钮（aria-label 为 Send / Send message 等）；找不到带标签的按钮时，才用输入框里最后一个图标按钮，且排除附件、工具、模型等按钮。点击与在编辑器里按回车交替进行，每次之后检查输入框是否已清空，最多 5 次；只有问题还在输入框里时才会再试，所以不会重复发送。5 次都没发出去时，多面板页会弹出提示，并在控制台打印发送按钮的标签，方便排查。真实 claude.ai 上未验证。
17. 网页模式下，只要另外两个面板开着，网格里的 Gemini 面板就当作验证方：不收 Send All，也不算 A 或 B。不再要求先到设置里勾选确认；第一次验证时，Verify 面板会就地请你确认一次。点 Send All 时 Verify 区自动展开，下方的 Gemini 验证面板随之出现。
18. Gemini 页面里嵌套的子框架原先也会给扩展页发消息，Chrome 会报 "target origin ... does not match"。现在只有直接嵌在多面板页里的框架才会发，与上游 Panelize 2.3.x 的写法一致。
19. 实测时出现过：两个回答都已生成完，状态却一直停在「等待」。真实网页的结构我拿不到，原因无法确定。已做的处理：
    - 完成判定加了上面那两条兜底规则；
    - 状态栏悬停和 Verify 窗口里会显示抓取诊断（提问轮数前后对比、是否找到回答及字数、页面是否显示仍在生成）；
    - 抓取进行中，状态栏有「立即抓取」按钮。
20. Verify 默认在后台验证（网页模式下每次都做），结果在独立小窗里查看（见 2a）。状态栏显示版本序号 `Build N`，每次更新加 1，方便确认装的是不是新版。

### 尚未实现

- P1：自动检测需要重新验证的回答、多轮上下文验证。（历史、JSON 导出、一致率统计、失败重试、搜索/调用计数已做。）
- P2：在原回答中高亮错误陈述、双向顺序审核、多次采样 / 多 Judge、位置偏差检测、有无 Grounding 对比等均未做。
