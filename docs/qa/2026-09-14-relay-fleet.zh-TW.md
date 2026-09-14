# Relay Fleet 本機驗證

## 實作範圍

開發分支新增 Lattice Remote／Relay 的 Fleet 能力宣告、主機工作區及分項授權，
並將控制端 `remote_fleet` 接到既有工作區 MCP adapter。多個 Agent 仍由背景服務
各自持有 PTY；傳輸依 session ID、request ID 與輸出 cursor 路由有界快照。
沒有開啟外部主機分享、安裝 sidecar 或使用模型帳號。

同時修正共用回覆通道只能在對話分享開啟時收取回覆的限制。
CLI／Fleet 請求先分別檢查能力，回覆只交給相同連線世代下的已登記請求；
取消會清除名額，已交付回覆的 ID 保留到呼叫端結束，避免舊清理動作移除新請求。

## 通過的檢查

| 項目 | 結果 |
| --- | --- |
| `npm run typecheck` | 通過 |
| `npm test -- --maxWorkers=4` | 129 個檔案；894 通過、2 跳過 |
| `npm run build` | 通過；前端入口 393.17 KiB，限制 500 KiB |
| Desktop 與 Remote `cargo fmt --all -- --check` | 通過 |
| Desktop `cargo check --locked --offline` | 通過 |
| Remote `cargo check --locked --offline --features agent` | 通過 |
| Remote `cargo test --locked --offline --features relay-server --lib` | 94 通過 |
| Desktop 測試執行檔 `fleet` 篩選 | 10 通過、2 ignored |
| Desktop `remote_chat_host::tests` | 1 通過 |
| `git diff --check` | 通過 |

Remote 測試包含實際 loopback Relay、端對端加密握手，以及兩個獨立 PTY ID
請求與反序回覆的配對；該層使用合成回覆，不宣稱在 Relay 上執行真實 CLI。
Desktop 測試另外透過真正背景服務及兩個 PTY 驗證工作區限制、重送不重啟、
主機與 daemon 權限交集，以及撤權後拒絕新請求但保留背景任務。
控制端 fixture 使用正式請求／回覆處理方法，確認只開 Fleet、未開對話也能回覆，
且未宣告能力、權限不足或連線世代改變時都拒絕操作。

Windows 測試先以 `cargo test --lib --no-run` 產生執行檔，再將副本放到忽略的
`output/`，嵌入專案現有 `scripts/windows-lib-test.manifest` 後執行。
原始 Cargo 產物的 SHA-256 在操作前後一致。未修改安裝版或 Cargo 依賴版本。
保留既有 Windows unused imports／`after_replace` 警告。

## 瀏覽器檢查

使用真實 React 元件及合成原生橋接器；fixture 位於忽略的 `output/playwright/`。
控制端選取純終端 Fleet 主機時只開放 Fleet 範圍，舊版主機的 Fleet 選項停用。
提交查看權限時確認送出的 grant 不含執行檔或可由控制端選擇的主機路徑。
主機設定另檢查工作目錄、讀取／控制／啟動勾選框及窄版配置。
390×844 下的權限選項逐列排列，無水平溢出；調整後重跑 19 項對話框測試與
production build，均通過。14 份異動文件的 207 個本地連結也已檢查。

## 未驗證的邊界

- 未驗證外部 Windows、macOS 或 Linux 主機，以及跨 NAT／公網 Relay 的完整操作。
- 未執行需要真實 Codex 帳號、編譯版 MCP binary 的兩個 ignored SSH 驗收案例。
- 未驗證已發布資產、sidecar 打包、安裝版、CI 或發行流程。
- Fleet 頁的遠端分割面板、巢狀派工與託管團隊服務仍未提供。

使用及大小限制見 [Relay Fleet 工作區](../RELAY_FLEET.zh-TW.md)。
