# 儲存庫檢查與原生還原修正

## 範圍與結果

以主線 `1c2c69eb` 與既有未提交的 `agent.rs` 修改為起點，先執行
`git pull --ff-only`，保留原修改，沒有 stash 或還原。

- 原生還原：前端會保存權限旗標，Rust 原本只接受單一 model，導致
  Codex、Claude、Gemini 還原被拒。保留各 CLI 白名單旗標及有限值，
  明確還原與 Codex 最近對話還原共用判定。
- 既有草稿解析器先移除權限參數，可能接受 `--model --sandbox
  read-only model` 這種不連續配對。改成逐對解析，拒絕未知／跨 CLI
  旗標、缺值、空 model、重複參數、提示文字與其他子命令。
- vendored GLib 在目前 Rust 產生 34 個警告；補齊既有省略的生命週期，
  移除不必要的 trait object 括號，沒有變更執行邏輯或略過警告。
- package.json 與開發文件未配置前端 lint 指令；不另外加入工具。
  以既有 `npm run check` 檢查版本、Actions、Vitest、型別及正式建置。
- 平行測試重現資料庫編輯誤報「其他程式正在修改」：檔案鎖只靠關閉
  handle 釋放，fork 暫時繼承 handle 後會延長鎖生命週期。加入明確解鎖
  的守衛，涵蓋資料庫與相同機制的 MCP 稽核儲存；回歸以複製 handle
  模擬繼承，確認舊 handle 存活時可重新取得鎖，新鎖也不被誤解開。
- 封存協定 fixture 曾遇 `Text file busy`；每次改用獨立且已關閉寫入
  handle 的暫存執行檔，避免兩輪重寫同一路徑。未加入產品層自動重試。
- 額外執行 GLib 最佳化安全回歸時發現測試內的 deprecated／dead code
  警告：改用 `MAX`，並實際建立各 derive 型別及呼叫 downgrade。

## 本機檢查

- `npm run check`：272 檔通過、1 檔略過；2043 項通過、2 項略過。
  TypeScript、正式建置、版本及 Actions 檢查均通過。
- `npm run build:sidecars` 通過。
- 桌面 `cargo test`：1053 項通過、39 項略過；整合測試另有 18 項
  依既有宣告略過（外部容器／原生環境），沒有冒充通過。
- 桌面 `cargo check --all-targets`、Clippy `--all-targets -- -D warnings`
  通過；桌面、三個 crates、GLib 及簽章工具的 fmt 全部通過。
- 三個獨立 crates 的測試、全 targets Clippy（`-D warnings`）及 fmt
  通過；remote 啟用 `agent client-cli relay-server`。
- 真實本機 OpenSSH 回歸 22 項、加密文字 E2E 1 項通過。
- GLib release `variant_iter::tests` 11 項及 derive 1 項通過。
- 更新簽章相容性的 locked/offline fixture 7 項通過、1 項略過。

以上最終檢查沒有失敗或警告；前兩輪失敗及修正原因保留在前文。

## 近期修改審查

檢視最近 20 筆提交，功能變更集中在 Fleet 查詢／操作、啟動交接及
MCP 被動連線，其餘為版本與依賴更新。

- Fleet：查詢序號、主機及元件存活檢查可阻止晚到回應覆蓋新主機；
  啟動鎖以主機／項目區分，送出與取消共用同步鎖，失敗保留草稿。
  既有延遲 Promise 測試涵蓋切換、輪詢、撤權與快速連點。
- 啟動交接：只有待送、無草稿及無未完成貼上時放行有效左鍵聚焦；
  方向鍵、拖曳、其他滑鼠按鍵及分段輸入仍保守阻擋，已有 PTY 回歸。
- MCP 被動連線：不自動啟動路徑先連線才讀取憑證；缺服務時不建立
  token／目錄，已有失敗連線與保留既有憑證回歸。

這些路徑未另發現可重現的本機缺陷；不代表所有環境均沒有 bug。
本次另行處理尚無整合回報時的前景 MCP 就緒規則。

## 仍需外部或人工驗收

| 項目 | 本機能確認 | 尚缺證據 |
| --- | --- | --- |
| 原生權限還原 | 參數白名單、啟動計畫及最近對話選取 | 安裝版重開與真實 CLI 還原 |
| Fleet 切主機／重複操作 | 模擬 API 延遲與互動回歸 | 安裝版及真實遠端工作 |
| 代理模型選單 | 既有測試與歷史隔離代理紀錄 | App 終端分頁及真實代理鍵盤操作 |
| Windows Fleet | 跨平台邏輯與本機測試 | 外部 Windows OpenSSH、具名管道、多 ConPTY 與真 CLI |
| 連線簿／背景啟動 | 權限及服務單元測試 | 安裝版開關、外部 CLI 讀取、啟動及撤權 |
| VNC／SSH／RDP／Remote | 本機協定與隔離測試 | 外部主機、跨裝置鍵鼠及 Relay Fleet |
| 真實 AI 雙工作者 | 保留既有驗收紀錄 | 登入、工具執行與供應商實際回合 |
| macOS／Windows／iOS | 本機無法取代平台驗收 | 原生 GUI、裝置、簽章及安裝包 |

依據：`BACKLOG.zh-TW.md`、三份 `MCP-*-ACCEPTANCE.zh-TW.md` 及
近期 QA 文件。CHANGELOG 是歷史修正紀錄，不能把其中「失敗」字樣
一律視為目前缺陷；較晚的真實雙 Codex 通過紀錄也不覆寫舊失敗證據。

本次未操作 CLIProxyAPI 服務或設定、未發版、未部署、未更新安裝版。
