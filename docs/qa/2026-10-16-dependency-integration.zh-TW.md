# 五項依賴集中整合候選

## 範圍與提交保留

從主線 `d55890443a0374e2ad846f1f16ca97b0d6d89fdd` 建立
`build/dependency-integration-20261016`，依序正常 merge 下列精確 head：

| 原 PR | 納入的 head | 最終版本 |
| --- | --- | --- |
| #311 | `45d2971ff59e54cc9e7c8ddbe2e658fb326a0848` | serde_json 1.0.154 |
| #312 | `ea27502330457269c1e4a1c55b68a0a99e7e2855` | actions/setup-node 7.1.0，SHA `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| #319 | `9c10f6aab0dd7de7bba8ae11da4aa70241924d6e` | tauri-plugin-updater 2.13.3；minisign-verify 0.3.0 |
| #321 | `2032decd91d96ecb5219280259bd326ea0018f5f` | @tauri-apps/plugin-opener 2.7.1 |
| #322 | `23e53f205a272eee351811c2cc79de77c5452667` | tauri 2.12.2 |

Cargo.lock 由 Git 三方合併自動整合，沒有衝突，未以任一支鎖檔覆蓋其他
更新。先前七項主線成果保留；upload-artifact 全部固定在
`cf430e030ddbb5b0abf93d22962f4752f3646cd9`。不納入 #309 或 #323。
雙版本簽章測試 crate 另外固定 minisign-verify 0.2.5 與 0.3.0，
與正式應用程式只使用 0.3.0 的鎖檔用途不同。

## 集中驗證與平台取捨

建議先由 coordinator 對最終精確 SHA 單次執行既有 CI：

- Linux quick check：實際執行新版 setup-node、前端安裝與完整檢查、
  桌面 sidecars、Rust 測試與 clippy，共用鎖檔及七項離線簽章夾具。
- macOS remote text safety：驗證平台原生編譯、文字安全、桌面結束路徑
  與 seatbelt；updater 含 macOS 原子替換調整，不能只看 Linux。
- Windows 的 updater 安裝／替換與 Tauri 原生程式碼不由上述兩平台
  覆蓋。至少仍需精確候選的 Windows 桌面編譯及相關測試；coordinator
  可檢視既有 Windows 工作的最小必要範圍後安排，不把 installer 成功
  或真桌面操作當作已完成。writer 不派送或修改工作流觸發政策。
  目前 `windows-test-installer.yml` 是含 installer 的單一 job，沒有
  精簡模式 input，不能宣稱可直接 dispatch 個別 step；若選用此既有
  工作流，須按整個 job 評估成本。Linux／macOS 綠燈不是 Windows 綠燈。

不因這批桌面依賴安排 #309 的 iOS 幾何重驗；iOS／真實安裝／執行中
桌面都不由本機測試或上述 CI 自動證明。公開 macOS 發行資產在雙版
簽章驗證通過的八項本機紀錄，見既有 updater 相容 QA；CI 只跑不需
資產的七項固定夾具。

## 合併與失敗處理

整合候選本機已執行 `npm ci`、`npm run check`：1647 項通過、1 項
既有跳過，含型別檢查、production build、入口大小 362.28 KiB 與
10 個工作流固定 SHA 檢查。Rust `cargo fmt --all -- --check`、
`cargo check --locked --all-targets`、完整 lib 963 項通過／38 項既有
ignored，以及 `cargo clippy --locked --all-targets -- -D warnings`
均通過。Rust 檢查以 `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`
排除未打包 sidecars，不能當成完整 sidecar 建置或安裝包驗收。
簽章 crate 的 fmt、locked fetch 與 offline test 通過：7 項通過，
實際資產 opt-in 測試維持 1 項 ignored，不隱藏其差異。
另核對全部 10 個工作流的觸發設定與主線完全相同，沒有建立新 workflow。

本候選保留五個原 head 為祖先；合併時必須用一般 merge，不能 squash
或 rebase，否則不能以祖先關係保留原 PR 的實際合併判定。CI 門檻通過
後，仍須逐支讀 GitHub 的 merged 狀態、merge commit 與主線祖先關係；
不能以關閉原 PR、僅納入差異或整合 PR 已合併代替這項核對。若 GitHub
未標記原 PR merged，保留未解狀態，不能回報全部合併。

若平台失敗，先區分環境與變更造成的失敗；不得略過檢查當綠燈。
#312 僅更新 Action，#321 的 ESM／CJS／型別檔先前已實測新舊相同，
原分支仍保留。若失敗僅涉及 updater 或 Tauri 平台程式，可針對
#312／#321 原 head 與當時主線整合所需的獨立門檻交付；整合候選必須
再納入更新的主線並重新判斷必要驗證，不盲搬鎖檔或重用舊 head 綠燈。
