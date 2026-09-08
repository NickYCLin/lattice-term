# Release 自動化與版本規則

LatticeTerm 只提供一條正式版更新通道，不區分 Beta、Nightly 或其他測試版。Release Please、Conventional Commits 與 Tauri Action 負責版本、待發布清單、驗證與安裝包。**日常 commit／push 不會立即發版**；每天台灣時間 10:17 自動檢查，距上次正式發布至少 7 天、有新內容且完整 CI 通過，才自動合併 Release PR 並發布，不需人工確認。draft Release PR 只是下一版的待發布清單，不是另一種版本。

## 版本如何判定

從上一個 Git tag 起，Release Please 依提交類型套用 SemVer：

| 最高影響提交 | 版本變化 | 範例 |
| --- | --- | --- |
| `feat:` | minor | `0.2.0` → `0.3.0` |
| `fix:`、`perf:` | patch | `0.3.0` → `0.3.1` |
| 類型後加 `!`，或內文含 `BREAKING CHANGE:` | major | `0.3.1` → `1.0.0` |
| 只有 `docs:`、`test:`、`ci:`、`chore:`、`style:`、`refactor:`、`build:` | 不版更 | 等待下一個可發布變更 |

提交標題必須符合 Conventional Commits，且專案提交說明使用繁體中文，例如：

```text
feat(遠端): 加入 Relay 連線模式
fix(RDP): 修正高 DPI 游標座標
feat(設定)!: 調整連線設定格式
```

PR 的 CI 會驗證每一筆非合併提交的格式。若需明確指定下一版，可在提交內文使用 `Release-As: 0.4.0`；這是例外操作，提交內容必須說明原因。

## 自動週期發布政策

小項目仍應在完成相稱驗證後提交並推送到 `main`。每次 push 只建立或更新同一個 draft Release PR；不會因滿 3 筆提交、出現 `BREAKING CHANGE`，或有人把 PR 改為 ready 就立即發版。

一般正式版必須同時符合：

- 由每日排程觸發，或執行未勾選 `force` 的例行 `workflow_dispatch`。
- 距最近一次已公開正式版的 `published_at` 至少 7 × 24 小時；不以 tag 建立時間、草稿建立時間或 commit 數計算。排程是 UTC `17 2 * * *`，即台灣時間每天 10:17；GitHub 排程可能延遲，因此這是檢查時間，不是保證公開安裝包的時間。
- 自上次公開版本起，至少有一個 `feat`／`fix`／`perf` 或不相容變更；只有維護提交或沒有內容就跳過。破壞性標記影響 SemVer，但不代表急件。
- 對即將發布的不可變 commit SHA 跑完整前端、Rust、SFTP 整合測試與 lint，全部成功。
- 測試期間主分支與 Release PR 沒有變動，合併後的檔案樹與測試快照一致。

時間與內容判斷在 `scripts/decide-release.mjs`；GitHub 版本歷史、候選快照與合併防競爭檢查在 `scripts/release-gate.mjs`。符合條件後，workflow 自動將草稿 PR 轉正、合併、建立 tag、建置並公開安裝包，正常流程沒有確認步驟。

未到期、沒有內容或 CI 失敗時保留待發布清單，下次每日排程重新檢查；不需要人工核准，也不會為了維持週期發布空版本。因為每天只檢查一次，正常間隔約 7～8 天，沒有新內容時更久。

GitHub API 失敗、發布時間格式錯誤、主分支或 PR 快照不一致時，一律不發布。沒有查到資料不能當成首次發版；只有 API 明確回傳沒有正式版本，才走首次發布流程。

保留 `workflow_dispatch` 的 `force` 作為緊急維運入口，平常不需要使用。它只略過 7 天間隔，**不能略過完整 CI、快照與安裝包檢查，也不能發布空內容**。適用情況包括：

- 可被利用的 high／critical 安全或供應鏈漏洞。
- 密碼、金鑰、權杖或其他敏感資料外洩。
- 資料遺失或無法復原的資料損毀。
- 正式版在廣泛環境無法啟動，或核心連線功能全面不可用。

一般介面瑕疵、單一平台邊界案例與低風險錯誤留在待發布清單，依相同自動週期處理。

## 自動發布流程

1. 一般 push 與功能 PR 在 Linux amd64 執行前端檢查、Rust 格式、測試與 lint，並於 macOS 驗證遠端文字編輯的原生權限、加密連線及桌面結束選單；PR 另外檢查 Conventional Commits。符合路徑條件的功能 PR 亦會建立 Windows 測試安裝包、驗證 Windows 分享端拒絕文字編輯的邊界，以及執行既有 iOS 未簽章建置驗證；這些測試產物不是正式發布。
2. `Release` workflow 讀取最近公開正式版與目前版本的未完成發布狀態；舊草稿或預發行標記不重設週期。
3. 若有可發布變更，自動建立或更新一個 draft Release PR，內容包含新版本、`CHANGELOG.md` 與所有版本檔差異；workflow 會自動合併同一版本內由 merge commit 與原提交造成的重複 changelog 項目，並檢查版本檔是否同步。
4. 只有到期時，才透過可重用的 `ci.yml` 額外驗證 Release PR 的確切 SHA；一般 push 不會重複執行這份發布驗證。CI 失敗不合併 PR，也不建立新 tag。
5. 完整 CI 成功後，自動以預期 PR head SHA 合併，複查合併的父提交與檔案樹，再於同一 run 建立 `vX.Y.Z` 與草稿 GitHub Release。使用 `GITHUB_TOKEN` 合併不會啟動另一份 workflow，因此不能依賴下一個 push 事件。發布提交可跳過一般 push CI，因為候選內容已完整驗證。
6. Linux amd64、Linux arm64、Windows amd64、macOS arm64、macOS Intel 原生 runner 建置安裝檔，上傳更新簽章與 `latest.json`；Android 只在簽章金鑰齊全時建置並附加 APK。Intel 使用明確的 `macos-15-intel` runner；`macos-latest` 是 Apple Silicon，無法取代 Intel 建置。
7. 發布 job 先以 `scripts/validate-updater-manifest.mjs` 檢查必要平台鍵、版本、架構、已上傳的更新包與簽章檔，再將同一份繁中版本說明同步到 GitHub Release 與 `latest.json`，全部通過才公開 Release。

Release PR 與候選 CI 是正式發布閘門，由 workflow 自動處理，不需要人工合併。一般功能 PR 不應手動修改版本、建立 tag，或直接建立同版本 Release。

## 同步的版本來源

Release PR 會一起更新：

- `package.json`
- `package-lock.json` 的根版本與 workspace 根版本
- `.release-please-manifest.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock` 中的 `lattice-term` 套件版本

`npm run version:check` 會比對上述七個值，`npm run check` 與 CI 都會執行它。任何來源漂移都會在合併或發布前失敗。
由於 Cargo 會移除 lockfile 內的自訂註記，Release workflow 會先執行 `npm run release:normalize-changelog` 與 `npm run version:sync-lock`，移除同版本的重複 changelog 項目、只同步 `lattice-term` package block，再以繁中 bot commit 寫回 Release PR。

## 簽章與失敗處理

- GitHub Actions 必須保存 `TAURI_SIGNING_PRIVATE_KEY` 與 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。缺少私鑰時發布會直接失敗，避免產生客戶端拒絕的未簽章更新包。
- Tauri updater 簽章用來驗證更新內容，與 Windows Authenticode 或 Apple Developer ID／notarization 是不同層次。目前自動化保證 updater 簽章；正式對外散佈前仍應補齊各作業系統的發行者憑證。
- 某個平台失敗時，草稿 Release 不公開；下次排程會辨識目前 manifest 版本的草稿，重新驗證原 tag SHA 並重跑同版本安裝包，不另建版本。合併 PR 後、建立 tag 前中斷時，也會從尚未標記完成的 Release PR 找回合併 SHA 再驗證。仍可手動重跑失敗 job 加速復原。
- 不自動發布與目前 manifest 版本無關的舊草稿，不倒退正式版本，也不覆寫已公開版本。發布狀態或 tag 在驗證後被更動時停止處理。
- `latest.json` 的 `notes` 必須與 GitHub Release 本文一致，避免應用程式內的更新視窗顯示空白版本說明。
- macOS 必須同時提供 `darwin-x86_64` 與 `darwin-aarch64`，並保留對應的 `-app` 平台鍵。漏掉 Intel 平台會使既有 Intel 安裝版直接回報檢查更新失敗，即使更新網址本身回應 HTTP 200；不可將其他架構的更新包填入缺少的平台。
- `workflow_dispatch` 可重新整理 Release PR；若沒有可發布提交，它不會憑空增加版本。

## 維護規則

- 小項目也要在相稱驗證後提交並推送。
- 所有提交使用繁體中文 Conventional Commit。
- PR 通過必要檢查並完成審查後合併到 `main`。
- 未到期或驗證未完成的 Release PR 保留待發布狀態；版本同步檢查完成只代表候選版本格式正確，不代表應立即發布。
- Release PR 的 `CHANGELOG.md` 不可包含語意相同但 commit 連結不同的重複項目。
- 合併後刪除已整合的功能分支；不可讓長期分支成為另一條發布來源。
