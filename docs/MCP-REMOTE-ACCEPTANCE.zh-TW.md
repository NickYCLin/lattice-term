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

## 安全檢查

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

## 真實 CLI 與未完成驗收

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

雙 Agent 協作仍須取得官方回報與各自結果，不能用合成狀態或本文件的原生測試替代。PR 保持 Draft，issue 尚未關閉。macOS 桌面、外部主機與 D 遠端畫面不在本次已通過範圍；D 並非原提案 A／B 的前置要求。
