# Windows MCP 問候協定修正與例行檢查

## 根因與修正

以 `e0953f8e` 為基準，先執行 `git pull --rebase origin main`。
核對 Actions run `40778690777`、job `123134522542` 的日誌及
`LatticeTerm-Windows-MCP-acceptance` 產物，兩項失敗均為協定不同步：

- `e8e06d05` 新增專案啟動授權時，observer 協定從 2 升為 3。
- Windows 驗收仍用版本 2 建立 raw observer，服務端因此正確拒絕問候。
- MCP adapter 已送版本 3；legacy pipe fixture 卻仍斷言版本 2，
  因此隔離測試也失敗。不是 `2e0834aa` 或 `b4a15bb5` 的就緒回歸。

驗收工具改用具名 desktop／observer 版本常數，問候、legacy 嚴格斷言
及證據輸出共用同一版本。沒有放寬角色、版本或私密資料隔離檢查，
也沒有改動產品問候協定或 CLIProxyAPI。

Linux Vitest 比對 Rust 與驗收常數，並確認實際問候及隔離斷言使用它們。
修正前已重現 `expected 2 to be 3`，修正後通過。Rust 真實 duplex
傳輸測試另加入舊 observer v2，確認拒絕回應不含資料、不訂閱事件，
並關閉連線。

## 額外發現

- vendored RDPDR 獨立執行 rustfmt 有既存差異；只套用格式化。
- GLib 完整測試的 NULL 結尾檢查用了 `get_unchecked(len)`，違反
  slice 邊界，在目前 Rust 直接中止。改用配置內的原始指標讀取結尾，
  保留 NULL 斷言；沒有修改產品實作。
- GLib structured log 測試假設上游 workspace 的 `glib/tests/...`
  路徑，獨立 crate 實際為 `tests/...`。改以同一來源的 `file!()`
  精確比對，保留所有日誌欄位與行號檢查。
- CI 加入兩個 vendored crates 的格式及完整測試，保留 GLib release
  安全回歸，避免只跑 focused tests 而漏掉上述測試缺陷。

## Linux 本機驗證

| 範圍 | 測試結果 | 其他檢查 |
| --- | --- | --- |
| 前端 | 279 檔通過、1 檔略過；2115 項通過、3 項略過 | tsc、正式建置、入口大小、版本、Actions 檢查通過 |
| 桌面 | 1086 項通過、40 項略過；整合測試另略過 18 項 | check 全 targets、Clippy 全 targets 且 `-D warnings` 通過 |
| Remote（agent/client-cli/relay-server） | 179 項通過、11 項略過 | Clippy 全 targets 且 `-D warnings` 通過 |
| RDP | 7 項通過 | Clippy 全 targets 且 `-D warnings` 通過 |
| VNC | 9 項通過 | Clippy 全 targets 且 `-D warnings` 通過 |
| 更新簽章相容工具 | locked/offline 7 項通過、1 項略過 | Clippy 全 targets 且 `-D warnings` 通過 |
| vendored RDPDR | 35 項通過 | Clippy 全 targets 且 `-D warnings` 通過 |
| vendored GLib | 完整測試 279 項通過、34 項略過；release variant_iter 11 項通過 | 獨立全 targets Clippy 尚有 65 項既有診斷 |
| 本機 OpenSSH | 22 項通過 | 真實本機子系統 |
| Remote 加密文字 E2E | 1 項通過 | 真實本機加密連線 |

所有七個 manifest 的 `cargo fmt --all -- --check` 通過；sidecars
建置通過。桌面測試啟用 `LATTICETERM_REQUIRE_SANDBOX_TEST=1`。
略過項仍依既有測試宣告，不將外部容器、原生平台或裝置項目當成通過。

GLib 的額外獨立 Clippy 診斷含省略生命週期、跨位置泛型限制、冗餘
轉換、transmute 型別與既有公開 FFI macro 在 unsafe 區塊展開參數。
沒有為消除診斷而加入 allow、降低 lint 等級或變更公開 FFI macro
安全契約。第一方 crates 的嚴格 Clippy 均通過，但不能宣稱所有
vendored crates 的獨立嚴格 Clippy 也通過。

## 稽核未完成項與驗收邊界

已對照 `2026-10-26-repository-audit.zh-TW.md`：原生權限還原、Fleet、
代理模型選單、連線簿及遠端桌面仍缺安裝版／外部環境或人工操作證據，
本次不把既有 Linux fixture 當成那些項目的完成證據。

Windows CI 的具名管道、ConPTY 與原生測試結果須另外追蹤；即使 CI
通過，仍不能取代 Windows 安裝版 GUI、外部 OpenSSH、多 ConPTY
真實 CLI、背景啟動／撤權與跨裝置操作。macOS／iOS 原生裝置、簽章
及安裝包亦未在本機驗證。本次沒有操作 CLIProxyAPI、部署或發版。
