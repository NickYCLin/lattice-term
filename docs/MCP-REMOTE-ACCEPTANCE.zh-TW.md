# MCP 遠端操作與紀錄驗收

這份紀錄接續 [#180](https://github.com/NickYCLin/lattice-term/issues/180)，記錄 2026-09-08 的候選版檢查。實作、測試程序與安裝版是不同層次；以下沒有操作既有正式主機或使用者的日常工作階段。

## Windows 本機

`cargo fmt --all -- --check`、`cargo check`、`cargo clippy --lib -- -D warnings` 通過。Rust 測試執行檔仍需使用副本加入 Common Controls v6 manifest，做法與限制見 [Windows 驗收紀錄](MCP-WINDOWS-ACCEPTANCE.zh-TW.md)。未更動原始測試產物、系統 DLL 或已安裝的 LatticeTerm。

| 實際執行的測試 | 結果與範圍 |
| --- | --- |
| `agent_daemon::` | 74 項通過，包含 22 項紀錄儲存、13 項桌面橋接，以及既有 observer、取消、重送與管道測試 |
| `mcp_desktop::` | 17 項通過，包含真實 TCP loopback SSH 的信任、指令結果、取消、逾時及失聯撤權 |
| `metrics::` | 5 項通過 |
| Windows 環境繼承 | 3 項通過，不截斷 PATH、不改系統設定，帳號與 reporter 覆寫仍有效 |
| 終端輸入所有權 | 2 項通過，DECRPM 回報不占用人工輸入；未知控制碼仍視為人工操作 |

總計 101 項，是指定範圍的 Windows 原生測試，不是整個專案所有 Rust 測試。橋接的 13 項測試也曾連續重跑 20 輪，確認 Windows 管道在取消 accept 後仍保留已連入的 client。

另以本機 debug 主程式執行 `scripts/verify-mcp-windows.mjs`，不加 `--external-reporter`，10 項 MCP／具名管道／ConPTY 驗收全部通過。本次 reporter 確實由 ConPTY 裡的合成 fixture 呼叫，不再從外部注入；仍不是 AI 供應商的就緒 hook。工具探索確認 15 個工具，未授權的遠端清單為空、主機查詢遭拒絕。

主程式 SHA-256：`4c3e064f948f8af0f5ece843b45258c53c85f6abfdf11c33bc10cff7ed513747`。完整結果見 [原生 reporter 驗收報告](assets/mcp-windows-native-reporter-20260908.json)。這份主程式只用於獨立暫存環境，未安裝或覆蓋日常版本。

新增介面用真實 React 元件與 mock Tauri 回應測過授權／撤權、SSH／SFTP 權限分流與窄視窗。畫面見 [SFTP 授權表單](assets/mcp-remote-sftp-narrow.png)；這不是安裝版或真實遠端連線的操作驗收。

### A／B 後續修正：`4be3aca`

加入獨立內容授權與 Windows Codex 提交防護後，重新執行 fmt、`cargo check --tests`、Clippy 與 debug 主程式建置，皆通過。連同待提交的真實 CLI 驗收腳本，前端完整測試為 109 個檔案、702 passed／2 skipped，型別檢查及 production build 通過；英文／繁中 390px 的權限欄位已用真實 React、mock Tauri 與瀏覽器重測，沒有狀態重疊或水平溢出。這不代表 Codex 真實派工已成功，後述雙 Agent 驗收仍失敗。

最後一份 Windows 原生測試副本共 124 項通過：`agent_daemon::` 85 項、`mcp_desktop::` 17 項、`metrics::` 5 項、環境繼承 3 項、輸入所有權 2 項、Codex 提交 12 項。測試副本 SHA-256 為 `2a89b52ab9124143f9a71774b787d0c90b2120de7351056574106d704c981b86`。Codex registry 回歸使用自有原生程序搭配測試 writer，不能代替真正 Codex 回合驗收。

新主程式 SHA-256 為 `154b2cc78116833b9e826d3862175e0f1ac3b73276ac184bebabcf394ac094e3`。以它重跑具名管道／ConPTY 驗收，11 項全部通過，包含只分享狀態、另外授權內容、撤銷內容後仍可控制，以及 raw observer 不附帶私人啟動資料。仍由 ConPTY 內合成 fixture 呼叫 reporter；完整結果見 [11 項原生報告](assets/mcp-windows-native-4be3aca.json)。

零模型按鍵探針確認 Windows 會移除貼上框架，將同批文字與最後 Enter 交成零間隔原生按鍵；分段寫入後，實測間隔為 260／263ms。正文 LF 與 Tab 也會成為 Enter／Tab，故 Windows Codex MCP 在寫入或排隊前拒絕 CR、LF、Tab，不默改文字。中文與 emoji 在納入原生 Alt key-up 的 UTF-16 回報後完整一致。這些是輸入轉換證據，不是模型任務成功證據；行為與接管方式見 [MCP 工具文件](MCP.zh-TW.md)。

後續延遲消費端 1 秒的對照顯示，即使寫入端間隔 250ms，讀取端仍可能在同批事件內處理最後文字與 Enter，觀測間隔為 0ms。因此固定等待不能保證 Codex 已離開貼上判定；尚不能把它當成真實派工失敗的唯一原因。

### Codex 真實輸入框的零付費對照

使用相同的 Codex 0.153.4 原生程式，但改用全新、未登入的設定目錄，模型端只連本機 loopback HTTP 固定回應；不複製原帳號設定、不呼叫外部模型、不發出工具操作。正常消費輸入時，250ms 與候選 End／Enter 路徑都能把 637 字正文完整交給 HTTP fixture，並取得第二輪官方完成通知與 MCP 讀回結果。這排除了「只要用 250ms 就必定失敗」的錯誤判斷。

另在每組新建 CLI 的啟動回合完成後，短暫暫停該自建程序的全部執行緒約 1 秒；身份、執行緒集合與恢復數量都有核對，不操作既有使用者程序。先在暫停期間完成一次輸入，再恢復程序：

| 同樣的輸入積壓條件 | 既有 MCP 250ms | 候選貼上／End／Enter |
| --- | --- | --- |
| 寫入在恢復前完成 | 是，303ms | 是，47ms |
| 原文完整到達模型 HTTP | 否 | 是，唯一一份 637 字正文 |
| 第二輪官方完成通知 | 無 | 有 |
| MCP 讀回固定結果 | 無 | 有 |
| 執行緒恢復／自建程序清理 | 全部確認 | 全部確認 |

完整 metadata 見 [消費端積壓對照](assets/mcp-codex-consumer-backlog-20260908.json)。這確定了固定寫入間隔無法抵抗消費端積壓，也支持在已核對預設快捷鍵的範圍使用 End；[Codex 貼上狀態機](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/paste_burst.rs#L417)與[輸入處理](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/chat_composer.rs#L3771)是對照依據。候選組由桌面測試通道送入，不是最終 MCP 產品路徑或真實模型驗收，也不證明先前付費派工失敗當下具有相同排程。

## 安全檢查

### 已驗證設定的產品路徑

後續主程式改為「核對啟動設定 → 貼上 → End → 單次 Enter」，不再以 250ms 等待判定輸入已被消費。只支援經核對的原生版本及預設鍵位；人工輸入、設定變動、撤權或停止都會重新檢查，無法確認時不送出、不自動重試。啟動計時也移到設定探測之後，避免探測時間提前觸發初始提示。

`72296d16fabf1d8b99f71b869ac262cccca5169d1ed7dfd714745689c54ab123` 的主程式通過 [11 項具名管道／ConPTY 驗收](assets/mcp-windows-native-qualified-20260908.json)。另以真正 Codex、全新未登入目錄及本機固定模型回應，驗證以下產品路徑；[報告摘要](assets/mcp-codex-input-qualified-20260908.json) 不含畫面、提示全文或機器路徑。

- 正常情境：真正 `send_agent_prompt` 接受完整設定資格，637 字正文完整且只送達一次，第二輪官方完成與 MCP 讀回均通過。
- 1 秒暫停：寫入請求約需 6 秒，消費端已先恢復，因此沒有形成指定積壓條件。原報告保留未通過，不當作回合失敗或積壓驗收成功。
- 獨立的新工作階段改固定暫停 10 秒：寫入在 5437ms 回覆、暫停實測 10014ms；60 個自建執行緒全部恢復，15 秒獨立保護計時未觸發。原文、第二輪官方完成及 MCP 讀回均通過。模型結果期限仍為 30 秒，未重送任何一個工作階段的提示。

Debug 版的正常啟動請求實測 14802ms、送指示請求 5718ms；包含設定重驗、PTY 與 RPC，不是單獨磁碟雜湊耗時，也不能當作 release 版效能數據。所有測試自建 CLI、launcher 與 fixture 均已清理；這一組是合成模型回應，不是真實 AI 工作結果。

新版原生 library 測試副本在進入測試前遭本機 Windows 回覆 `Access is denied`；未修改安全設定、未改名繞過，也未將未執行的測試算通過。沒有找到足以歸因的防護事件。已將指定範圍的 Windows library 回歸接入隔離 CI：精確選取 Cargo 產物，只在自有副本加入 manifest，核對實際測試數、原始產物雜湊與清理結果；忽略的供應商驗收仍不執行。CI 結果另行記錄。

前端完整回歸為 110 個檔案、715 passed／2 skipped（`--maxWorkers=4`），型別、production build、原生 runner 純邏輯自測與 Actions pinning 通過。先前高並行執行曾有一組既有 React 測試逾時；沒有放寬測試期限，降低並行數後全數通過。

### 首字元保護後的原生驗收

加入首字元 `?` 防護後，主程式 SHA-256 為 `d5b4d3611559497f1a158b4a01954b0dc1cd6364ba8eb1e58162861c2b32721f`。以這份主程式重新執行 [11 項具名管道／ConPTY 驗收](assets/mcp-windows-native-final-20260908.json)，全部通過，包含 metadata-only、獨立內容權限、撤權、去重與工作階段取消隔離。reporter 仍由 ConPTY 內的合成 fixture 呼叫，沒有外部注入；這不是供應商模型回合或安裝版驗收，也不會取代先前 `72296d16` 產物的報告。

### 權限與資料保護

- 遠端 scope 預設關閉，grant 綁定既有 live registry handle；失聯後原 ID 永久失效，重新授權必須取得新 ID。
- 連線摘要與主機指標只提供核准名稱、opaque ID 與數值，不附帶 host、帳號、指令、絕對根目錄、掛載路徑或 filesystem。另行授權的終端輸出、命令結果與檔名仍可能含敏感內容，會交給所選 client。
- 根目錄及其祖先連結換置、hardlink、FIFO、路徑跳脫、外部檔案衝突都有對應防護。遠端路徑檢查仍依賴合作的 SFTP 伺服器，不是 chroot。
- exec 使用專用 channel，取消及逾時不影響原 SSH 終端；EOF 不當成 exit 0，也不宣稱所有衍生程序已被終止。
- 傳檔不覆寫既有檔案。無效請求不占去重紀錄；同一 request ID 不因重送而再執行。
- 紀錄採 owner-only 有界原子快照，不保存提示、原始錯誤、憑證或路徑。儲存失敗不清空既有紀錄，也不阻止 CLI 啟動；突然終止仍可能遺失待寫快照。
- Gitleaks 8.30.1 已掃描本次變更 diff，未發現機密資訊；這不是整個 Git 歷史或外部相依套件的安全認證。

## Linux OpenSSH 與 CI

CI 的既有命令會執行新增的隔離測試：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib openssh_ -- --ignored
```

新增 fixture 經真實 TCP SSH、`SftpRegistry` 與 OpenSSH `sftp-server` 執行分塊上傳／下載及雜湊核對；另驗證不覆寫、撤權、根目錄限制，以及拒絕 rename 時保留原檔、清除 staging。這是臨時 loopback SSH peer 加真正 SFTP subsystem，不是 OpenSSH `sshd`、正式主機或桌面安裝驗收。

`00f07cabdcf617da20b243195fc85b650e41d1f3` 的 [Linux CI](https://github.com/NickYCLin/lattice-term/actions/runs/34192984153) 已通過：主程式 library 測試 527 passed／20 ignored，上述 OpenSSH 指定測試另有 12 passed。這是 CI 的 Linux 結果，不是本機 Windows 執行 Unix-only 測試。

同一 head 的 [Windows 安裝包建置](https://github.com/NickYCLin/lattice-term/actions/runs/34192984154) 與 [iOS 驗證](https://github.com/NickYCLin/lattice-term/actions/runs/34192984142) 也已通過。Windows 產物仍須另行下載核對，不能僅憑建置成功宣稱安裝驗收完成；後續 commit 也必須重跑 CI。

### `4be3aca` 的 CI 與 Windows 下載產物

- [Linux CI](https://github.com/NickYCLin/lattice-term/actions/runs/34199229340)：前端 677 項、Rust library 545 passed／20 ignored，另行執行的 OpenSSH 測試 12 項通過。
- [Windows CI](https://github.com/NickYCLin/lattice-term/actions/runs/34199229338)：安裝包與 11 項 MCP 合成 fixture 驗收通過；CI 使用外部 reporter。
- [iOS CI](https://github.com/NickYCLin/lattice-term/actions/runs/34199229394)：未簽署的 simulator／device 產物、隱私檢查、模擬器啟動及截圖驗證通過。

重新下載兩份 Windows artifact，ZIP 的 SHA-256 均符合 GitHub metadata digest；安裝包雜湊也與 CI 日誌一致。PR merge checkout 與 `4be3aca` 的 source tree 相同。解出的主程式與 CI 測試主程式只差 Tauri bundler 的 `UNK`／`NSS` 標記：僅在記憶體還原該標記後，整份檔案雜湊完全符合 CI；未修改磁碟上的主程式。來源與雜湊鏈見 [下載來源核對](assets/mcp-windows-download-4be3aca.json)。

直接使用解出的原始主程式，在新建的隔離環境重跑 11 項 MCP 驗收，全部通過；本次由 ConPTY 內的 fixture 呼叫 reporter，沒有使用外部 reporter。完整結果見 [下載產物驗收](assets/mcp-windows-consumer-4be3aca.json)。所有測試自建程序已退出。這是未簽署 CI 產物的消費端檢查，不是正式 release、安裝流程或真實 AI 回合驗收。

## 真實 CLI 驗收歷程

真實 Claude Code 2.1.222 與 Codex 0.153.4 已在隔離 ConPTY 工作階段啟動，並取得各自官方就緒依據；MCP 同時派送及相同 request ID 去重已通過，但雙 Agent 檔案檢查尚未通過。

- Claude 在任務送出後回報 `needsAttention`，畫面顯示尚未登入；官方 `claude auth status --json` 也回報未登入。沒有代改登入資料。
- Codex 的啟動測試回合有官方完成通知；後續檔案檢查在 90 秒期限內未取得完成通知與可核對答案，不能當作任務完成，也不能歸因於 Claude 的登入狀態。
- 測試端只讀取新建的 TypeScript／Rust 小型 fixture，並核對檔案未修改；這不是整個專案的 typecheck／Cargo 驗收，也不是另一個 AI 自主操作 MCP 的示範。
- Codex 的信任設定只限單次啟動參數；Claude 的 CLI 確認了本次新建資料夾的信任提示，可能在供應商設定保留該暫存專案的信任紀錄。測試未手動改寫或刪除供應商設定、憑證或其他專案的信任狀態。

### 雙 Codex 後續驗收：未通過

Issue 不限定兩種供應商，因此另以 `4be3aca` 主程式和 Codex 0.153.4 啟動兩個真實、獨立的工作階段，各自使用新建的前端／Rust fixture。完整結果保留在 [雙 Codex 報告](assets/mcp-codex-pair-4be3aca.json)，沒有刪除失敗項目。

- Node stdio driver 完成 MCP 初始化、分享／內容／控制授權、兩份派工及相同 request ID 去重；兩個啟動回合均取得官方完成通知。
- 兩份後續檢查在 180 秒內都未取得可核對答案及該回合的官方完成通知。寫入後的 `working` 來源是 heuristic，不能據此認定模型開始工作。診斷只保留有界、固定分類及最後畫面訊號，不保留原始對話，因此也不能斷言整輪從未出現進度。
- 測試程式獨立執行已安裝的 TypeScript／Rust 原生編譯器，前後檢查均 exit 0，來源雜湊一致；這不證明模型執行了相同編譯器。
- 取消隔離因前置檢查未完成而明確失敗，沒有用最後清理程序替代驗收。撤權通過，兩個測試自建 CLI PID 均確認退出，fixture 已清除。
- 未更動登入資料、既有 CLI、已安裝程式或正式遠端主機，也未因失敗自動重送提示。

可重現腳本為 `scripts/verify-mcp-live-agents.mjs`，`--codex-pair` 使用同一供應商的兩個工作階段。預檢與原生探針不呼叫模型；`--run-live` 才執行真實模型回合，會使用現有帳號額度。這是 Node MCP client 操作真實 AI worker，不是另一個 AI 自主呼叫 MCP 的示範。

### 已驗證輸入設定的雙 Codex：通過

同一天以修正後的主程式重跑兩個真實 Codex 0.153.4 工作階段，完整 [雙 Agent 報告](assets/mcp-codex-pair-qualified-20260908.json) 保留主程式、CLI、編譯器與 fixture 雜湊。本次 16 項檢查全部通過：

- 兩個獨立工作目錄分別檢查 TypeScript／Rust fixture；兩份派工都只送出一次，相同 request ID 重送取得去重結果。
- 各自取得正確的 nonce 與計算答案，以及該輪官方完成通知。輸出從真正 MCP 分頁讀回並還原終端畫面，沒有用桌面旁路或 heuristic 工作狀態當成功證據。
- 獨立原生編譯器前後檢查 exit 0，來源檔案雜湊不變，未執行編譯後程式。模型被要求執行 checker，但報告不冒稱已獨立證明模型執行了編譯器。
- 透過 MCP 結束前端 CLI，確認官方關閉事件及自有 PID 退出；Rust CLI 同時仍存活並保持分享。最後撤權後清單為空，兩個自有 CLI 與 fixture 均完成清理。

本次未更動登入、使用者原有 CLI、已安裝程式或正式主機。這是 Node MCP client 派工給兩個真實 AI worker，不是另一個 AI 自主呼叫 MCP 的示範。先前失敗報告仍保留，不能因本次通過就改寫先前結果。

### 首字元保護後的雙 Codex：舊解析器未通過

以同一份 `d5b4d361` 主程式執行的 [舊解析器報告](assets/mcp-codex-pair-final-guard-20260908.json) 保留 `passed: false`。該次 Rust 回合已有官方完成通知，但答案驗證未通過，取消隔離也因前置條件不足而失敗。後續診斷發現，正確 nonce 與計算值 `22` 後接分號，被舊版結果正規表示式排除；不能把這個解析器問題描述成 CLI 沒有完成回合。

另僅從該次自建 fixture 的供應商最終回覆，確認有 checker exit 1 的回報，原因仍不明。這是診斷線索，不是模型編譯成功或編譯器實際執行狀態的獨立證明；測試程式自行執行的編譯器前後檢查 exit 0 也不能消除這項差異。沒有從供應商歷史重新判綠舊 MCP 報告；原始失敗、撤權及兩個自有 CLI 清理結果全部保留。

### 同一主程式與修正解析器的新驗收：協作檢查通過

修正解析器後，以相同 `d5b4d361` 主程式、新建的兩個 Codex 工作階段與 fixture 重新執行，沒有沿用舊回合。這次自 2026-09-08 10:11:47 UTC 至 10:13:05 UTC 的 [新報告](assets/mcp-codex-pair-final-parser-20260908.json) 為 16 項通過：

- TypeScript／Rust 來源檢閱均透過 MCP 取得正確 nonce、計算值及該回合官方完成通知；相同 request ID 重送沒有再次派工。
- 取消前端工作階段後，官方關閉事件與自有 PID 退出均確認，Rust 工作階段仍存活且保持分享。最後撤權清單為空，兩個自有 CLI 均退出，fixture 已清理。
- 獨立原生編譯器的前後檢查均 exit 0，fixture 來源與輸出雜湊一致，未執行編譯後程式。

通過的是協作、來源檢閱、獨立編譯器檢查與取消／撤權邊界，不是「兩個模型都成功執行編譯器」。新的 MCP 讀回證據另外保存 checker 失敗回報：前端為空，Rust 為 `[1]`，不因後續畫面更新而清除；來源明示為未受信任的 CLI 文字，原因仍不明。驗收由 Node MCP client 派工給真實 AI worker，不是模型自主呼叫 MCP；輸出驗證使用 raw MCP 分頁及終端 renderer，也不是預設去除控制碼模式的驗收。

最終 head 的 CI 與 Windows 下載產物仍須核對後才能合併並關閉 issue。macOS 桌面、外部主機與 D 遠端畫面不在已驗證範圍；D 並非原提案 A／B 的前置要求。

## 2026-09-11 Linux 發版前驗收（`47231d0`）

合併 #201、#202（Tauri 外掛、vitest 5、russh 0.63.2 升級）後，在 Linux x86_64（Ubuntu，核心 7.0）用 debug 主程式重跑 #180 的 A／B／C。全部使用新建的暫存資料目錄、自有 daemon 與 fixture，沒有碰使用者平常的資料目錄、工作階段或正式主機；驗收腳本放在被 git 忽略的 `src-tauri/target/`，沒有提交。

自動測試：`npm run check`（115 檔 772 測試、production build、版本一致）、`cargo fmt --check`、`cargo clippy --all-targets -D warnings`、`cargo test`（主程式 572 通過、29 ignored），以及 CI 用的 `openssh_ -- --ignored`（21 通過，含 3 項 MCP 桌面 registry 經真實 OpenSSH `sftp-server` 的傳檔）。

| 階段 | 方式 | 結果 |
| --- | --- | --- |
| A | Node JSON-RPC client 經 stdio 連 `lattice-term mcp`；daemon 裡三個 `/bin/sh` PTY | 20／20：協定 2 與內容授權能力、15 個工具、分享前看不到、第一次分享只有 metadata 且不能讀內容、摘要不含執行檔／參數／帳號目錄／PID／原生 ID、未分享的工作階段與輸出不外露、預設分頁停在 `ESC[` 之前（F2）、`maxBytes: 1` 讀「中」與 🙂 各前進 3／4 bytes（F3）、超過 256 KiB 保留範圍回 `truncated`、分頁讀到結尾、等待中的其他呼叫 2 ms 回應、撤銷分享 0.3 秒內以 `revoked` 結束等待（F1）、程序結束回 `closed`、daemon 停止後回報未執行且 adapter 不會自己拉起 daemon |
| B | 兩個真實 Codex 0.153.4 背景工作階段（同一登入帳號、各自的 fixture 目錄），只經 MCP 派工 | 21／21：兩邊 bootstrap 回合都以官方 notify 回 `done/integration`；`now` 各派一次、同 requestId 重送回 `duplicate`、同 id 換內容被拒；忙碌時 `queue` 排隊、`cancel scope=queue` 丟掉且那段文字從未送進 PTY；兩邊都讀回正確 nonce 與計算值（TypeScript 95、Rust 27）；獨立 tsc／rustc 前後檢查一致、fixture 未變；使用者打了草稿沒按 Enter 時 `now` 被拒、`queue` 等待；`cancel scope=session` 只結束前端那個 CLI（PID 確認退出）、Rust 仍在跑且保持分享；撤權後看不到也不能派工；桌面操作紀錄有這個 client 的寫入 |
| C | Xvfb 裡的桌面程式用拋棄式金鑰連本機臨時 `sshd`（127.0.0.1:2223，OpenSSH），在設定頁授權 SSH（主機資訊＋固定指令）與 SFTP（列目錄、上傳、下載，限定遠端／本機根目錄） | 21／21 加撤權與關桌面：能力回報 `desktopSshSftp` 可用且 2 個授權；清單只有這兩個、不含主機／埠／帳號／指令／實際路徑；主機資訊回數值；`ssh_exec_job` 先回 operation、重送不重跑、stdout／stderr／exit 3 分開保存；未核准的 plan 與錯用後端被拒；`..`、連結、絕對路徑、`sub/../..` 全被拒；下載與上傳落在核准目錄、既有檔不覆寫（`file_conflict`）、失敗傳輸不留殘檔、本機根目錄外的路徑被拒；在介面撤回 SSH 授權後主機資訊與指令立即被拒而 SFTP 仍可用；只關桌面程式、daemon 仍在時，授權數歸零且 SFTP 被拒 |

限制與觀察：

- B 的 Codex 用 `--sandbox danger-full-access`。這台主機不允許 Codex 的 bwrap 建 user namespace，`read-only` 沙箱下 checker 與 `cat` 都回「Operation not permitted」；第一次跑兩個 worker 都如實回報失敗，LatticeTerm 的派工、官方完成與讀回本身正常。fixture 完整性由驗收程式事後核對。
- 撤權後 PTY 裡已經打進去的字收不回，這次沒有測「已接受但結果未知」的情境，只靠既有單元測試。
- C 是本機 loopback，不是外部或正式主機；桌面在 Xvfb 用 debug 主程式與 Vite dev server 執行，不是安裝版。
- 在 dev 模式連上 SSH 時，右側檔案面板出現一次「A directory listing is already running for this session」。dev 版 React StrictMode 會把 effect 跑兩次，production build 是否也會出現沒有驗證。
- 金鑰路徑欄位的範例顯示成 `C:Usersyou.sshid_ed25519`，是語系檔反斜線沒有跳脫，修在 #203。
- macOS 桌面、Windows 安裝版、D 遠端畫面仍不在這次範圍。


## 2026-09-12 Linux VNC 鍵鼠與人工接手驗收

接續 #218 畫面擷取與 #219 鍵鼠實作，在獨立 Xvfb、loopback
x11vnc、GTK 3 測試視窗及獨立 app data 下，以 production frontend
嵌入 debug 主程式執行；不使用使用者帳號或正式主機。
MCP client 為 Node.js 22.22.1 的 JSON-RPC stdio client，呼叫實際
`lattice-term mcp`，經 daemon、desktop bridge 及 VNC sidecar 操作 GTK。

- 操作驗收 **10／10 通過**：擷取的尺寸與 client 憑據、點擊接受、相同
  request ID 去重、GTK 僅收到一次點擊、已消耗憑據拒絕、輸入框取得
  焦點、可列印文字、GTK 完整文字、Control+a、替換結果。
- 人工接手 **3／3 通過**：使用者在檢視器移動滑鼠後，500 ms 再查
  MCP 清單已無控制目標；舊憑據被拒；被拒的點擊未到達 GTK。
  清單已同步撤權時回 `needs_user_action`，要求重新連線／明確授權。
- 最後重新擷取並檢視實際 MCP JPEG：文字為 `DONE`、按鈕為
  `Clicks: 1`。接受訊息不代替這項畫面及 GTK 狀態驗證。

測試等待 GTK 狀態變化最多五秒，不將 `submitted` 當作完成訊號。
初次靜止畫面尚未產生授權後影格時會回 `not_ready`；暖機後才執行
操作驗收，這不是首幀延遲的效能保證。較早共用顯示器遭其他程序
介入的重跑結果不列入本次通過數；最後一輪的顯示器、資料目錄、
執行檔及 GTK 視窗均獨立。

本次另修正使用者接手後的授權清單同步：桌面先撤權，再非同步通知
daemon，人工輸入不等待 IPC；不必等候原本十秒一次的同步週期。
相關 Rust MCP 測試 88 項通過、4 項略過，debug build 與格式檢查通過。

這是 Linux loopback 的 VNC 實機程序驗收，尚未驗證外部 VNC 主機、
RDP／Lattice Remote 的實際鍵鼠、Windows／macOS 安裝版或跨主機 Fleet。
