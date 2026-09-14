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

## 後續公網 WSS 與實際 Agent 驗收

以下為同日追加驗收，基於 `2aadbc0` 加上本次驗收測試；前文保留首次本機
驗證範圍。此次已將公網 Relay 傳輸與真實雙 PTY 接在同一個案例中驗證。

實際路徑為：Windows 測試控制端 → 公網 WSS Relay → 同一台 Windows 的
新版 `lattice-agent.exe` → 原生 loopback bridge → 工作區 MCP → 真實背景服務
與兩個 ConPTY。TLS 正常驗證，OPAQUE 配對後建立 Noise 通道，重連核對原裝置金鑰。
橋接器測試接線取代 Tauri AppHandle 的回覆派送，但沿用正式 bearer 驗證、
去重、大小限制、撤權與工作區 adapter，未使用合成 PTY 回覆。

| 驗收項目 | 結果 |
| --- | --- |
| 真正 Agent 宣告 Fleet，CLI／對話／終端輸入／檔案權限保持關閉 | 通過 |
| 透過公網 WSS 啟動兩個獨立 PTY，讀取各自不同的輸出標記 | 通過 |
| 同一啟動 request ID 重送，仍只有兩個 PTY | 通過 |
| 斷線後重新配對並核對原金鑰，繼續讀取既有 PTY | 通過 |
| 未核准的工作區、任意工具、路徑覆寫及過大讀取要求 | 均遭拒絕 |
| 背景服務撤銷其中一個 PTY 的輸出權限 | 該 PTY 後續讀取遭拒絕 |
| 停止主機 bridge，拒絕後續讀取及曾提交的啟動要求 | 通過，既有兩個 PTY 仍保留 |
| 測試結束後清理測試 Agent 與 PTY | 未發現殘留程序 |
| 既有外部 Relay 與 Agent 服務 | 驗收前後均為 active，未替換或重啟 |

新增 opt-in 案例 `fleet_real_agent_over_deployed_relay_with_two_ptys`：
**1 通過，11.96 秒**。另重跑 Fleet 相關 **10 通過、2 ignored**，
主機 bridge **1 通過**。兩份 manifest 的格式檢查、Desktop `cargo check`、
Remote `cargo check --features agent` 與新版 Agent 編譯均使用 `--locked --offline`
（格式檢查除外）並通過。Windows 測試副本沿用前述 manifest 做法，原始 Cargo
產物雜湊未變。此次只新增測試接線與文件，未修改前端，未重跑前端全套檢查。

重現時先編譯此分支的 Agent 與 Desktop library tests，將
`LATTICE_FLEET_ACCEPTANCE_AGENT` 設為該 Agent 的絕對路徑，
`LATTICE_RELAY_SMOKE_ENDPOINT` 設為操作者核准的 Relay，再單獨執行此 ignored
案例。端點不寫入版本庫。測試使用新的隨機配對碼與臨時裝置身分；配對碼走 stdin，
不使用既有裝置、模型帳號或使用者工作區。臨時本機資料隨測試結束清理；Relay
可能保留該測試裝置的註冊 claim，依服務原有保留政策處理。

### 仍不能視為完成的驗收

- 控制端與被控端同在 Windows 主機，雖然經過公網 Relay，仍不代表兩台不同
  終端主機、不同 NAT 或行動網路的完整驗收。
- 外部 Linux ARM64 被控端目前安裝 `2.0.0`，缺少新版 Desktop 編譯需要的
  GTK／WebKit 開發套件；本次只讀檢查，沒有安裝套件或替換服務。
- 未走正式 Tauri 設定介面與 MCP 用戶端全流程，未使用真實模型 CLI 測試提示、
  官方就緒 hook 或取消本輪工作；雙 PTY 使用隔離的測試 shell。
- 查詢目前開發分支的 GitHub Actions，未找到執行紀錄；CI 不列為通過。
- 尚未完成安裝包、sidecar 封裝、macOS／Linux 被控端與發行資產驗收。
