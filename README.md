# Panelize Verify

> **Based on [Panelize](https://github.com/Manho/Panelize) by Xiaolai and Wenhao (MIT License).**
> This repository is a modified version of Panelize v2.2.4. It keeps Panelize's full git history and all of its original features, and adds the "Verify" workflow described below. It is not affiliated with or endorsed by the Panelize authors.

**本项目基于 [Panelize](https://github.com/Manho/Panelize)（MIT 协议）修改而来**，在 Panelize v2.2.4 的基础上增加了"先人工投票、后揭示 Gemini 核查"的评测流程。Panelize 的原有功能全部保留，原版说明见 [PANELIZE_README.md](PANELIZE_README.md)（[简体中文](README.zh-CN.md) · [日本語](README.ja.md)）。

## 它做什么

1. 同一个问题同时发给两个 AI 网页（例如 ChatGPT 和 Claude），并排显示回答。和 Panelize 一样，这一步直接使用你在这些网站上的登录状态，不需要它们的 API Key。
2. 两个回答都生成完后自动抓取，**你先投票**：A 更好 / B 更好 / 平局 / 跳过。
3. 投票保存后，才显示 Gemini 的结果：
   - 把两个回答拆成可核查的陈述，用 Google Search 逐条核查（支持 / 反驳 / 证据不足 / 无法核查）；
   - 在不知道模型名、也不知道你投票的情况下，对两个匿名回答（X / Y，顺序随机）给出比较结论；
   - 对比你和 Gemini 的判断是否一致。
4. 每次比较保存在本地，可导出 JSON。

Gemini 有两种工作方式，在设置里切换：

- **网页模式（默认，免费）**：上方两个面板回答，下方的「Gemini verifier」面板用 gemini.google.com（你的 Google 登录，不需要 API Key）按**验收模板**做验收：事实核查 + 逻辑审查 + 验收结论。投票前这个面板被盖住，投票后可以直接读 Gemini 的完整报告。顶部的 Gemini 面板在这个模式下不参与回答。模板可在设置里修改。来源是 Gemini 回答里写的链接，只有同时出现在 Gemini 页面引用中的才算已确认。
- **API 模式**：用 Gemini API 和 Google Search Grounding，来源取自结构化的搜索元数据，更严格；需要 API Key 和结算账号。

## 与 Panelize 相比的改动

| 类别 | 文件 |
|---|---|
| 新增：回答抓取（只读 DOM） | `content-scripts/answer-extractor.js` |
| 新增：会话状态、匿名化、Gemini 调用、证据映射、存储 | `modules/verify/` |
| 新增：Verify 面板界面、网页模式的 Gemini 验证面板与验收模板 | `multi-panel/verify-dock.js`、`multi-panel/verify-dock.css`、`multi-panel/verify-web-runner.js`、`modules/verify/acceptance-template.js` |
| 修改：接入面板、发送前后的钩子 | `multi-panel/multi-panel.js`、`multi-panel/multi-panel.html` |
| 修改：扩展名、Gemini API 主机权限 | `manifest.json`、`_locales/*/messages.json` |
| 新增：测试 | `tests/verify-*.test.js`、`tests/e2e/verify-flow.e2e.test.js` |

完整的设计说明、验收标准对照和已知限制见 [VERIFY.md](VERIFY.md)。

## 安装

不需要打包，也不需要 Node.js。Chrome 直接加载解压后的文件夹即可。

1. **下载并解压**：在 GitHub 仓库页点 **Code → Download ZIP**，然后把 zip **解压**。
   Chrome 不能直接加载 .zip 文件。
2. **找到正确的文件夹**：解压后要选的是**直接包含 `manifest.json` 的那个文件夹**，通常叫 `panelize-verify-main`。
   Windows 的"全部解压"经常多套一层，变成 `panelize-verify-main\panelize-verify-main\manifest.json`，这时要选里面那层。
3. **加载扩展**：Chrome 地址栏打开 `chrome://extensions`，打开右上角的 **开发者模式**。
   点 **加载已解压的扩展程序（Load unpacked）**，选第 2 步那个文件夹。卡片上出现 "Panelize Verify" 且没有红色"错误"按钮，就装好了。
4. **打开使用**：点浏览器工具栏的扩展图标（或按 `Ctrl+Shift+E`）打开多面板页，在前两个面板里登录要比较的 AI 网站。
5. **配置 Gemini**：
   - 网页模式（默认）：先在这个浏览器里登录 gemini.google.com；再到底部 **Verify** 面板 → ⚙，勾选网页模式的数据发送确认，保存。
   - API 模式：⚙ 里选 "API mode"，填入 Gemini API Key，勾选确认，点 "Test key & model"。

### 不要用"打包扩展程序（Pack extension）"

这个按钮是给要发布到商店的开发者生成 `.crx` 文件用的。普通 Chrome 只允许安装 Chrome 网上应用店里的 `.crx`，自己打包的 `.crx` 拖进去会被拦截（提示类似 `CRX_REQUIRED_PROOF_MISSING`，或"无法从该网站添加应用、扩展程序和用户脚本"）。第二次再打包还会因为同目录已有 `.pem` 私钥而失败。本地使用一律用"加载已解压的扩展程序"。

### 常见报错

| 现象 | 原因与解决 |
|---|---|
| "清单文件缺失或不可读取" / "Manifest file is missing or unreadable" | 选错了层级，或选的是 zip 本身。改选直接包含 `manifest.json` 的文件夹 |
| 选文件时只能选文件夹，看不到 zip | 正常现象：先解压，再选文件夹 |
| 拖入 `.crx` 后被拦截 | 见上一节，改用"加载已解压的扩展程序" |
| 扩展装上后过一阵消失或报错 | 解压出的文件夹被删除或移动了。Chrome 每次都从这个文件夹读取代码，请把它放在固定位置 |

### 更新到新版本

下载新的 zip，解压后**覆盖原来的文件夹（保持同一路径）**，然后在 `chrome://extensions` 里点这个扩展卡片上的刷新按钮 ⟳。

不要先"移除"再从另一个路径加载：未打包扩展的 ID 由文件夹路径决定，换路径或移除后，本地保存的比较历史和 API Key 都会丢失。

## 关于费用

- ChatGPT、Claude 等回答方走网页登录，和 Panelize 一样不经过 API，本扩展不产生额外费用。
- Gemini 网页模式同样走网页登录，不计费。
- Gemini API 模式走官方 Gemini API。目前 Gemini 3.x Flash / Flash-Lite 的免费层**不提供** Google Search Grounding，所以 Key 所在项目需要绑定结算账号；绑定后每月前 5000 次搜索免费（以 Google 官方价格页为准）。

## 测试

```bash
npm ci
npx vitest run           # 单元测试
npm run typecheck        # JSDoc 类型检查
npx playwright install chromium
npm run test:e2e         # 端到端测试（需要 Playwright 自带的 Chromium）
```

## 限制

- 回答抓取依赖各网站的页面结构，网站改版后可能失效；此时可在 Verify 面板里手动 "Capture now" 或 "Paste"。
- 网页模式还没有在真实的 gemini.google.com 上测过；如果读不到 Gemini 页面上的引用链接，所有陈述都会显示为"证据不足"。
- Google 的 Grounding 使用条款对修改、缓存搜索结果有限制；公开发布前请自行评估。

## 许可

MIT，见 [LICENSE](LICENSE)。保留 Panelize 原作者的版权声明。
