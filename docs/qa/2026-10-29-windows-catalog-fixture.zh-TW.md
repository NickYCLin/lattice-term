# Windows catalog 探測夾具修正與完整檢查

## 調查範圍

本次以 `d55635f6` 為基準，在指定分支先執行
`git pull --rebase origin main`，核對以下 Actions job 日誌：

| 執行 | Job | 首個失敗 |
| --- | --- | --- |
| main `40798795588` | `123201631351` | `cliproxy::catalog::tests::capability_probe_has_no_console_even_through_a_cmd_shim` |
| PR #348 `40778690777` | `123134522542` | MCP observer 問候版本不一致 |
| PR #349 `40778703144` | `123134567378` | MCP observer 問候版本不一致 |

兩個 rustls PR 的原始執行尚未進入 library regressions，不能視為
catalog 失敗的重現，也沒有證據指向 rustls 相依更新。
main 的 MCP 11 項已通過，catalog 測試則在直接呼叫 PowerShell
的斷言失敗，尚未走到 `.cmd` shim。

## 根因證據

保留舊 fixture、只新增階段記錄的診斷執行 `40822027928`
（commit `81d0fccb`、job `123276454836`）再次失敗：

```text
direct PowerShell fixture stages: Ok("started\n")
test result: FAILED. 6 passed; 1 failed; 1 ignored; ... finished in 10.95s
```

腳本已開始執行，但 `Add-Type -Path (Join-Path ...)` 未完成，
因此尚未到達 `assembly loaded`、主控台檢查或 JSON 輸出。
失敗屬於 PowerShell fixture 在隔離環境的組件／cmdlet 初始化階段，
耗盡產品探測期限；這份證據沒有再細分 Add-Type 與 Join-Path 的內部耗時。
沒有證據指向 JSON 換行、PowerShell 執行原則、`.cmd` 引號或
`CREATE_NO_WINDOW` 的產品錯誤。

`613e86da` 將能力探測改成清空環境並切換暫存 HOME，舊 PowerShell
fixture 由原本繼承環境的版本探測沿用至此，額外帶入了 shell 初始化
依賴。原生 fixture 可直接驗證 Codex 程序需要滿足的契約，無須在產品
探測期限內載入 PowerShell 組件。

## 修正與回歸保護

探測 fixture 改用事先編譯的獨立 Rust 程式，編譯保留 60 秒上限，
實際探測仍受產品原有 10 秒期限與輸出大小限制約束。
原生程式精確檢查探測參數、工作目錄、六個隔離環境變數與設定內容，
符合條件才輸出 developer instruction JSON。

相同測試現在可在 Linux 執行；Windows 額外驗證原生程式及 `.cmd`
shim 都沒有主控台，並用 `CREATE_NEW_CONSOLE` 對照確認 fixture
確實會以狀態 41 拒絕附帶主控台的程序。臨時路徑刻意含空白，保留
路徑與引號的回歸覆蓋。沒有新增略過項或放寬斷言。

本次產品程式與 CLIProxyAPI 服務端、設定均未改動。

## 本機驗證

所有七個 manifest 都執行完整 `cargo test`、`cargo check --all-targets`、
`cargo fmt --all -- --check` 與
`cargo clippy --all-targets -- -D warnings`。
Remote 啟用 `agent client-cli relay-server`；桌面啟用
`LATTICETERM_REQUIRE_SANDBOX_TEST=1`。

| Manifest | 通過 | 略過 | 嚴格 Clippy |
| --- | ---: | ---: | --- |
| 桌面 | 1087 | 58 | 通過 |
| Remote | 179 | 11 | 通過 |
| RDP | 7 | 0 | 通過 |
| VNC | 9 | 0 | 通過 |
| 更新簽章相容工具 | 7 | 1 | 通過 |
| vendored RDPDR | 35 | 0 | 通過 |
| vendored GLib | 279 | 34 | 65 項既有診斷，未通過 |

七個 manifest 的測試、check 與格式檢查全部通過。
桌面略過數含 40 項 library 測試與 18 項整合測試，保留既有宣告。

額外驗證：

- 前端 tsc、Vitest（2115 項通過、3 項略過）、正式建置、入口大小、
  版本與 Actions pinning 檢查通過。
- 原生 fixture 獨立 rustfmt、嚴格 Clippy 與 `--deny=warnings` 編譯通過。
  直接反向檢查確認錯誤 USERPROFILE 會失敗且不輸出 JSON。
- 更新簽章工具的 `--locked --offline` 測試通過。
- GLib release `variant_iter::tests` 11 項通過。
- 真實本機 OpenSSH 22 項及 Remote 加密文字 E2E 1 項通過。
- 三組 sidecar 建置與 Windows runner 的跨平台 `-SelfTest` 通過。

GLib 的 65 項既有診斷包含公開 FFI macro 在 unsafe 區塊展開參數。
直接移出 unsafe 會改變呼叫端契約，因此沒有為消除診斷而加入 allow、
降低 lint 等級或修改公開安全契約；本次未宣稱所有嚴格 Clippy 通過。

## 驗證邊界

Linux 的執行結果不能代替 Windows `GetConsoleWindow` 與 `.cmd` 執行。
Windows 安裝版 GUI、真實 Codex 啟動、多 ConPTY、外部 OpenSSH、
背景啟動與撤權仍需要 Windows 真機人工驗證；本次未執行這些項目。
