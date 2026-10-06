# 產品介紹素材

## 對話工作區預覽

每個 README 語系各一張，1200 × 780，淺色主題（霧藍）：

| 檔案 | 語系 |
| --- | --- |
| `chat-workspace.zh-TW.png` | 繁體中文 |
| `chat-workspace.en.png` | 英文 |
| `chat-workspace.zh-CN.png` | 簡體中文 |
| `chat-workspace.ja.png` | 日文 |
| `chat-workspace.ko.png` | 韓文 |
| `chat-workspace.es.png` | 西班牙文 |
| `chat-workspace.fr.png` | 法文 |
| `chat-workspace.de.png` | 德文 |
| `chat-workspace.pt-BR.png` | 巴西葡萄牙文 |

擷取日期：2026-10-06，來源為當天的 `main`。

圖片由 [`scripts/product-screenshots`](../../scripts/product-screenshots/) 產生：
以現有的 [ChatView](../../src/views/ChatView.tsx)、
[NavRail](../../src/components/shell/NavRail.tsx) 與 [ViewHeader](../../src/components/shell/ViewHeader.tsx)
渲染，套用應用程式的樣式，介面文字使用各語系的正式翻譯；外圍加上開發版示範標示，
沒有使用繪圖工具合成產品按鈕或功能。

工作階段、資料夾與對話內容都是為介紹編寫的範例，內容依據
[reading-list 筆記](../../examples/first-session/project-notes.md)，
各語系的範例文字寫在 [showcase.tsx](../../scripts/product-screenshots/showcase.tsx)。
這是介面元件的示範畫面，未連接 CLI、模型帳號或遠端主機，也不代表完成過真實模型任務。
截圖不含私人專案名稱、帳號、主機、憑證或模型使用量。

介面改版後重新產生：

```sh
npm run screenshots:product            # 全部語系
npm run screenshots:product -- ja ko   # 只更新指定語系
```

腳本會打包示範頁、以無頭 Chromium 擷取並覆寫上述檔案。優先使用 Playwright 下載的
Chromium（受公司政策管理的 Chrome 可能被強制擴充功能卡住），也可用 `CHROME` 指定瀏覽器。
覆寫後逐張檢查側欄、文字和輸入區完整可見，再提交。公開素材不可直接使用個人日常工作畫面。

## 工作流程示意

`workspace-overview.svg` 是原創的三步驟流程示意，並非產品截圖。
首頁目前使用上方的介面預覽，示意圖保留供教學文件使用。
