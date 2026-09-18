# Release 自動化與版本規則

LatticeTerm 只提供一條正式版更新通道，不區分 Beta、Nightly 或其他測試版。Release Please、Conventional Commits 與 Tauri Action 負責版本、待發布清單、驗證與安裝包。**日常 commit／push 不會立即發版**；每天台灣時間 10:17 自動檢查，當天尚未發布、有新內容且完整 CI 通過，才自動合併 Release PR 並發布，不需人工確認。draft Release PR 只是下一版的待發布清單，不是另一種版本。

## 版本如何判定

版號直接使用台灣日期：`YYYY.M.D`，例如 **`2026.9.18` 就是 2026 年 9 月 18 日編定的版本**。月份、日期不補零，維持 Cargo、npm、Tauri 與 updater 接受的三段數字格式。新增功能、修正和效能改善都使用同一套規則，不再由 commit 類型決定要增加哪一碼。

| 情況 | 版號 |
| --- | --- |
| 9 月 18 日有新功能或修補 | `2026.9.18` |
| 隔天又有新內容 | `2026.9.19` |
| 中間幾天沒有變更，到 10 月 2 日再發布 | `2026.10.2` |
| 跨年後的更新 | `2027.1.1` |
| 當天已發布，繼續新增功能或修補 | 累積到隔天，不覆蓋當天正式版 |

日期版號只代表時間，不承諾協定相容性。公開協定或資料格式的不相容變更仍須列出影響、遷移方法或相容處理。Git tags 保留，既有 `2.4.0` 升到日期版號在數字排序上是升級，不重設為 `1.0.0`，也不把舊版本重新貼標籤。

提交標題維持繁體中文 Conventional Commits，例如：

```text
feat(遠端): 加入 Relay 連線模式
fix(RDP): 修正高 DPI 游標座標
feat(設定)!: 調整連線設定格式
```

`feat`、`fix`、`perf` 決定是否有使用者可用的新內容，分類也保留在更新紀錄中；`BREAKING CHANGE` 用來說明不相容變更，不推高日期版號。不要用 `Release-As:` 指定別的版號；日期政策會在建立 Release PR 時明確指定版本。

### 參考與取捨

- [Chrome 的版本定義](https://www.chromium.org/developers/version-numbers/)把前兩碼視為發布里程碑；[2026 年 9 月起改成兩週一版](https://developer.chrome.com/blog/chrome-two-week-start)。主版號變化速度不符合本專案這次的目標。
- [VS Code 的更新紀錄](https://code.visualstudio.com/updates/archive)長期沿用 `1.x`，可參考其穩定產品世代的做法；本專案選擇更容易辨識新舊的日期版號。
- [Notion 的公開更新頁](https://www.notion.com/releases)以產品版本、日期和功能主題說明更新。這是對外溝通的參考，不能據此推定其桌面安裝包採用相同版號算法。

本專案不需要為每次新增功能或修補討論版本幅度，依實際有內容的日子持續發布即可。第一碼是年份，一年才變一次。

### Release Please 與安裝包相容性

`scripts/calendar-version.mjs` 計算台灣日期，遇到同日既有 tag 就保留變更到隔天；遇到較新的 tag 則中止，避免版號倒退。`scripts/create-calendar-release-pr.mjs` 使用鎖定版 Release Please 的 `Manifest.fromManifest(..., releaseAs)` API，從一開始就讓 PR 標題、本文、版本檔與更新紀錄採用同一日期，不在 main 插入版本提交，也不事後改寫工具產生的版號。建立 tag 和安裝包仍走既有 workflow；升級 Release Please 套件與 Action 時需一起跑日期版號整合測試。

Windows 目前只出 NSIS 安裝包，可用此格式；若未來新增 MSI，必須另行處理 [MSI 第一碼上限 255](https://learn.microsoft.com/en-us/windows/win32/msi/productversion)，不能直接把四位數年份塞入 MSI ProductVersion。iOS 的上架 build number 仍獨立遞增。Android 目前沿用 Tauri 的數字版碼換算，日期版號在現有年份仍位於可用範圍內；正式上架驗證與桌面發布是分開的邊界。

## 自動週期發布政策

小項目仍應在完成相稱驗證後提交並推送到 `main`。每次 push 只建立或更新同一個 draft Release PR；不會因滿 3 筆提交、出現 `BREAKING CHANGE`，或有人把 PR 改為 ready 就立即發版。

一般正式版必須同時符合：

- 由每日排程觸發，或執行例行 `workflow_dispatch`。
- 最近一次已公開正式版的 `published_at` 換算為台灣日期後，早於本次檢查日期；不以 tag 建立時間、草稿建立時間或 commit 數計算。排程是 UTC `17 2 * * *`，即台灣時間每天 10:17；GitHub 排程可能延遲，因此這是檢查時間，不是保證公開安裝包的時間。
- 自上次公開版本起，至少有一個 `feat`／`fix`／`perf` 或不相容變更；只有維護提交或沒有內容就跳過。不相容變更必須說明影響與遷移方式，但不會自動升主版號，也不代表急件。
- 對即將發布的不可變 commit SHA 跑完整前端、Rust、SFTP 整合測試與 lint，全部成功。
- 測試期間主分支與 Release PR 沒有變動，合併後的檔案樹與測試快照一致。

時間與內容判斷在 `scripts/decide-release.mjs`；GitHub 版本歷史、候選快照與合併防競爭檢查在 `scripts/release-gate.mjs`。符合條件後，workflow 自動將草稿 PR 轉正、合併、建立 tag、建置並公開安裝包，正常流程沒有確認步驟。

未到期、沒有內容或 CI 失敗時保留待發布清單，下次每日排程重新檢查；不需要人工核准，也不會為了維持週期發布空版本。以台灣日曆日限制一般發布一天一次，不要求相隔完整 24 小時，避免前一天的建置時間讓隔天排程誤判為尚未到期；沒有新內容時不發布。

GitHub API 失敗、發布時間格式錯誤、主分支或 PR 快照不一致時，一律不發布。沒有查到資料不能當成首次發版；只有 API 明確回傳沒有正式版本，才走首次發布流程。

保留 `workflow_dispatch` 供人工觸發當天的檢查，規則與排程相同；不提供同一天重複正式發布的 `force` 入口，也不能略過完整 CI、快照或安裝包檢查。已建立 tag 的失敗草稿可重試同一個候選快照，跨日重試仍保留原版號，不把同一版本指向另一份內容。

## 自動發布流程

1. 一般 push 與功能 PR 在 Linux amd64 執行前端檢查、Rust 格式、測試與 lint，並於 macOS 驗證遠端文字編輯的原生權限、加密連線及桌面結束選單；PR 另外檢查 Conventional Commits。符合路徑條件的功能 PR 亦會建立 Windows 測試安裝包、驗證 Windows 分享端拒絕文字編輯的邊界，以及執行既有 iOS 未簽章建置驗證；這些測試產物不是正式發布。
2. `Release` workflow 讀取最近公開正式版與目前版本的未完成發布狀態；舊草稿或預發行標記不重設週期。
3. 若有可發布變更，以台灣日期版號建立或更新一個 draft Release PR，內容包含新版本、`CHANGELOG.md` 與所有版本檔差異；workflow 會自動合併同一版本內由 merge commit 與原提交造成的重複 changelog 項目，並檢查版本檔是否同步。
4. 只有到期時，才透過可重用的 `ci.yml` 額外驗證 Release PR 的確切 SHA。Release Please 只在版本說明改變時才重寫 PR，所以若最後幾筆是 docs／test／chore，PR 會停在較舊的 main；此時 workflow 先用 GitHub 的 update branch（帶著剛讀到的 head SHA 防競爭）把目前的 main 快照合進 bot 的 PR 分支，再驗證新的 head，衝突或 PR 被改動就停下不發。
   一般 push 不會重複執行這份發布驗證。CI 失敗不合併 PR，也不建立新 tag。
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

## Releases 保留政策

GitHub Releases 保留最近三個已公開正式版，供目前版本與前兩版回退下載。完整歷史保留在 `CHANGELOG.md` 與 Git tags；清理只刪 Release 條目和附加安裝包，不刪 tag、不改寫 Git 歷史。更舊的安裝包不再提供下載，引用它們的固定下載連結也會失效。

清理在正式發布完成後執行：先確認 GitHub latest 指向本次版本，再從公開更新入口讀回 `latest.json`，沿用平台、資產與簽章檔驗證；通過後才移除保留範圍外的正式版。每次刪除前重查 latest 與目標 Release，版本或狀態被其他人改動就停止。草稿、預發行與非標準 tag 不會自動刪除。清理失敗不撤回已發布版本，應依工作日誌重試。

首次導入可執行一次人工觸發的當日發布，仍須通過候選 CI 與安裝包檢查；後續依每日排程執行。過期草稿需個別確認未再使用，不能納入正式版保留數量。
