# 任務 28：側欄資料夾名稱與操作空間

## 版面與操作決策

採用需求 2(b)：只有 hover／列內焦點／選單開啟時才預留操作空間。
原本四個工具按鈕收進單一「⋯」選單，包含上移、下移、移到上一層、
新增子資料夾、重新命名與刪除，避免工具列顯示後再次擠到只剩一兩個字。

桌面閒置時 folder-actions 為 display:none，寬度為 0；名稱使用扣除展開箭頭後的列寬。
顯示時只佔一顆按鈕的寬度，不覆蓋名稱，也不改變列高。
Tab 到名稱或列內控制項會顯示操作，方向鍵可操作選單；menu-open 類別讓焦點移至
portal 選單時觸發鈕仍可見。移動後聚焦名稱，Esc 回觸發鈕，點外關閉不搶走點擊焦點。
關閉選單會清除 menu-open；沒有 hover／焦點時不殘留操作列。

hover:none 與 app--mobile 常駐單一「⋯」，可直接觸控開啟完整操作選單。
選單開啟時仍移除資料夾名稱的原生 title，觸發鈕以 aria-label 說明；
選單使用既有主題 token、限制視窗內高度並可捲動。

## 修改檔案

- SessionProjectSidebar.tsx：只保留單一操作觸發鈕、menu-open 狀態與既有焦點行為。
- SessionFolderOrderMenu.tsx：整合資料夾操作、保留排序／上一層功能，避免選單超出視窗。
- connections.css／對應測試：閒置不佔位、hover／focus／menu-open 與觸控規則。
- 繁中／英文操作標籤與相關元件事件測試。
- scripts/session-folder-layout.mjs：實際側欄元件的名稱寬度量測。
- scripts/connection-card-layout.mjs：保留卡片對齊驗收，更新側欄共用樣式煙霧檢查。

## Chromium 量測

新增腳本直接伺服端渲染 SessionProjectSidebar，僅用三個假名稱：
「測試-子資料夾」「測試-桃源水情」「測試-航空城」，沒有讀取使用者資料。

六主題、320／760px 視窗、桌面／無 hover 觸控／行動介面、
閒置／hover／焦點／選單開啟四狀態，共 144 組全部通過。
桌面側欄實測預設寬度 240px；閒置時三個名稱的可見寬度均達完整文字寬度，工具列寬度為 0。
所有操作狀態均不重疊，名稱最小可見文字寬約 63.8px，高於四個全形字 48px 的門檻；
列高及相鄰列位置誤差不超過 0.75px。失敗訊息會包含主題、寬度、模式、狀態及每列量測。

測試須使用完整 Chromium；Linux 沒有 DISPLAY 時，腳本會啟動並清除隔離的 Xvfb，
以取得真實桌面 hover 能力，並確認觸控模擬真的符合 hover:none。
這些是開發測試工具，不是應用程式的執行依賴。可用 CHROME 指定完整 Chromium。

```sh
node scripts/session-folder-layout.mjs
node scripts/connection-card-layout.mjs
```

本次容器以 CHROMIUM_NO_SANDBOX=1 執行兩個隔離測試，沒有改動應用程式的安全設定。
原卡片腳本的 144 種版面也全部通過。

## 最終檢查與驗證邊界

- npx tsc --noEmit、npm run build 通過，入口 452.13 KiB（限制 500 KiB）。
- 全套 Vitest：2,642 通過、0 失敗、3 略過，包含任務 26／27 的跨層、排序、上一層與 title 測試。
- cargo fmt --all -- --check、cargo clippy --all-targets -- -D warnings 通過；未修改 Rust。
- 未發版、打 tag 或更新安裝版；未操作真實連線、憑證、CLIProxyAPI 設定或正式資料庫。
- 仍需 Windows／其他原生 WebView 安裝版確認滑鼠、實際觸控與系統字型下的觀感。
  Chromium 寬度與事件測試不代表所有原生環境都已實機驗證。
