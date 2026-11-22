# Panelize Verify

> **Based on [Panelize](https://github.com/Manho/Panelize) by Xiaolai and Wenhao (MIT License).**
> This repository is a modified version of Panelize v2.2.4. It keeps Panelize's full git history and all of its original features, and adds the "Verify" workflow described below. It is not affiliated with or endorsed by the Panelize authors.

**本项目基于 [Panelize](https://github.com/Manho/Panelize)（MIT 协议）修改而来**，在 Panelize v2.2.4 的基础上增加了"先人工投票、后揭示 Gemini 核查"的评测流程。Panelize 的原有功能全部保留，原版说明见 [PANELIZE_README.md](PANELIZE_README.md)（[简体中文](README.zh-CN.md) · [日本語](README.ja.md)）。

## 它做什么

1. 同一个问题同时发给两个 AI 网页（例如 ChatGPT 和 Claude），并排显示回答。和 Panelize 一样，这一步直接使用你在这些网站上的登录状态，不需要它们的 API Key。
2. 两个回答都生成完后自动抓取，**你先投票**：A 更好 / B 更好 / 平局 / 跳过。
3. 投票保存后，才显示 Gemini 的结果：
   - 把两个回答拆成可核查的陈述，用 Google Search 逐条核查（支持 / 反驳 / 证据不足 / 无法核查），来源链接只取自 API 返回的搜索元数据；
   - 在不知道模型名、也不知道你投票的情况下，对两个匿名回答（X / Y，顺序随机）给出比较结论；
   - 对比你和 Gemini 的判断是否一致。
4. 每次比较保存在本地，可导出 JSON。

## 与 Panelize 相比的改动

| 类别 | 文件 |
|---|---|
| 新增：回答抓取（只读 DOM） | `content-scripts/answer-extractor.js` |
| 新增：会话状态、匿名化、Gemini 调用、证据映射、存储 | `modules/verify/` |
| 新增：Verify 面板界面 | `multi-panel/verify-dock.js`、`multi-panel/verify-dock.css` |
| 修改：接入面板、发送前后的钩子 | `multi-panel/multi-panel.js`、`multi-panel/multi-panel.html` |
| 修改：扩展名、Gemini API 主机权限 | `manifest.json`、`_locales/*/messages.json` |
| 新增：测试 | `tests/verify-*.test.js`、`tests/e2e/verify-flow.e2e.test.js` |

完整的设计说明、验收标准对照和已知限制见 [VERIFY.md](VERIFY.md)。

## 安装

1. Chrome 打开 `chrome://extensions`，开启"开发者模式"。
2. "加载已解压的扩展程序"，选择本仓库根目录。
3. 打开 Panelize 多面板页，在前两个面板里登录要比较的 AI 网站。
4. 底部 **Verify** 面板 → ⚙：填入 Gemini API Key，勾选数据发送确认，点 "Test key & model"。

## 关于费用

- ChatGPT、Claude 等回答方走网页登录，和 Panelize 一样不经过 API，本扩展不产生额外费用。
- Gemini 核查走官方 Gemini API。目前 Gemini 3.x Flash / Flash-Lite 的免费层**不提供** Google Search Grounding，所以 Key 所在项目需要绑定结算账号；绑定后每月前 5000 次搜索免费（以 Google 官方价格页为准）。

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
- Google 的 Grounding 使用条款对修改、缓存搜索结果有限制；公开发布前请自行评估。

## 许可

MIT，见 [LICENSE](LICENSE)。保留 Panelize 原作者的版权声明。
