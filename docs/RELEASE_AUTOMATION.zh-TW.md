# Release 自動化與版本規則

LatticeTerm 使用 Release Please、Conventional Commits 與 Tauri Action 管理版本。系統會自動計算下一個版本並維護 Release PR，**合併 Release PR 才會正式發布**，因此版本判定可被檢視。合併這一步已自動化：每次 push 到 `main` 時 `Release` workflow 都會檢查一次，累積政策一成立就把 PR 轉正並合併，不等固定時間。draft Release PR 顯示的版本只是候選版本，不代表已對外發布。

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

## 累積發布政策

小項目仍應在完成相稱驗證後提交並推送到 `main`，但單一一般修正不應立即對外發布。Release Please 會持續更新同一個 draft Release PR，累積自上一個 tag 以來的可發布變更。

符合下列任一條件時，才將 Release PR 標示為 ready 並合併：

- 已累積至少 3 個彼此獨立、使用者可感知的功能或修正項目。
- 出現破壞性變更（`type!:` 或內文含 `BREAKING CHANGE:`）。
- 維護者明確要求發布目前已累積的內容。
- 發現需要立即處理的重大漏洞或重大故障。

這個判斷寫在 `scripts/decide-release.mjs`，由 `Release` workflow 在每次 push 到
`main` 時執行，成立就合併 Release PR。前兩條可由提交本身
判定所以完全自動；後兩條無法從提交類型看出來，需要維護者以
`workflow_dispatch` 勾選 `force` 觸發——那正是本政策保留給人的判斷。
即使勾了 `force`，changelog 內容為空時仍不會發版。

沒有排程，也沒有固定時間到期的發版：第 3 個獨立的 `feat`／`fix`／`perf` 合進
`main` 時就會發版，之後從零重新累積。這是刻意的取捨——維護者選擇「累積夠就
發」而不是「每天收一次」，代價是活躍時一天可能發好幾版。

累積數量以「使用者結果」計算，不以 commit 數量計算。同一問題拆成程式、測試與文件等多筆提交仍只算 1 項；`docs:`、`test:`、`ci:`、`chore:`、`style:`、`refactor:`、`build:` 本身不計入累積門檻，也不得為了湊數刻意拆分提交。

可以提前發布的重大情況包括：

- 可被利用的 high／critical 安全或供應鏈漏洞。
- 密碼、金鑰、權杖或其他敏感資料外洩。
- 資料遺失或無法復原的資料損毀。
- 正式版在廣泛環境無法啟動，或核心連線功能全面不可用。

一般介面瑕疵、單一平台邊界案例與低風險錯誤應留在 draft Release PR 內繼續累積。每日檢查只是判斷條件是否成立，**不因時間到期強制發布**：累積未達門檻就繼續等，等多久都不會自動放行。

## 自動發布流程

1. 一般 push 與功能 PR 只在 Linux amd64 執行前端檢查、Rust 格式、測試與 lint；PR 另外檢查 Conventional Commits。
2. `Release` workflow 讀取自 `v0.2.0` 或上一個 Release 起的提交。
3. 若有可發布變更，自動建立或更新一個 draft Release PR，內容包含新版本、`CHANGELOG.md` 與所有版本檔差異；workflow 會自動合併同一版本內由 merge commit 與原提交造成的重複 changelog 項目，並檢查版本檔是否同步。
4. Release PR 不再重複派送原始碼 CI。同一個 workflow 在每次 push 後接著執行 `scripts/decide-release.mjs`；條件成立時就地把 PR 標示為 ready 並合併，再於**同一個 run** 內第二次執行 Release Please 來建立 tag 與 GitHub Release。之所以不等 push 事件，是因為以 `GITHUB_TOKEN` 完成的合併不會觸發新的 workflow run，等下去永遠等不到。
5. 下一次 `Release` workflow 建立 `vX.Y.Z` tag 與 GitHub Release；發布提交會跳過一般 push CI。
6. Linux amd64、Linux arm64、Windows amd64、macOS arm64、macOS Intel 原生 runner 建置安裝檔，上傳更新簽章與 `latest.json`；Android 只在簽章金鑰齊全時建置並附加 APK。Intel 使用明確的 `macos-15-intel` runner；`macos-latest` 是 Apple Silicon，無法取代 Intel 建置。
7. 發布 job 先以 `scripts/validate-updater-manifest.mjs` 檢查必要平台鍵、版本、架構、已上傳的更新包與簽章檔，再將同一份繁中版本說明同步到 GitHub Release 與 `latest.json`，全部通過才公開 Release。

Release PR 是唯一正式發布閘門。一般功能 PR 不應手動修改版本、建立 tag，或直接建立同版本 Release。

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
- 某個平台失敗時，在 GitHub Actions 重新執行失敗的 job；Tauri Action 會尋找既有 tag 的 Release 並補上資產，不需再建同版本 tag。
- `latest.json` 的 `notes` 必須與 GitHub Release 本文一致，避免應用程式內的更新視窗顯示空白版本說明。
- macOS 必須同時提供 `darwin-x86_64` 與 `darwin-aarch64`，並保留對應的 `-app` 平台鍵。漏掉 Intel 平台會使既有 Intel 安裝版直接回報檢查更新失敗，即使更新網址本身回應 HTTP 200；不可將其他架構的更新包填入缺少的平台。
- `workflow_dispatch` 可重新整理 Release PR；若沒有可發布提交，它不會憑空增加版本。

## 維護規則

- 小項目也要在相稱驗證後提交並推送。
- 所有提交使用繁體中文 Conventional Commit。
- PR 通過必要檢查並完成審查後合併到 `main`。
- 未達累積發布門檻的 Release PR 必須維持 draft；版本同步檢查完成只代表候選版本格式正確，不代表應立即發布。
- Release PR 的 `CHANGELOG.md` 不可包含語意相同但 commit 連結不同的重複項目。
- 合併後刪除已整合的功能分支；不可讓長期分支成為另一條發布來源。
