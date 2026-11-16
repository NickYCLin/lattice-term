# 任務 31：撰寫區選單、標題與側欄資訊

## 修改內容與檔案

| 範圍 | 檔案與調整 |
| --- | --- |
| 主題化選單 | `ComposerMenu.tsx`、`ComposerPermissionMenu.tsx`、`chat.css`：權限改用帶說明的主題按鈕選項，沿用 menuNavigationIndex；portal 避開容器裁切，依視窗上下空間定位並限制高度 |
| 最近資料夾 | `ComposerProjectMenu.tsx`、`recentProjects.ts`、`ConversationComposer.tsx`、`ChatView.tsx`：先顯示最近八筆與搜尋，再由明確按鈕開系統選擇器，保留原有拖放／清除入口 |
| 標題優先序 | `SessionConversationPane.tsx`、`ConversationPresentation.tsx`、`ChatView.tsx`：自訂名稱、有效群組名稱、原生標題、第一則提示、CLI 的順序；次要晶片保留 CLI、已知帳號及模型 |
| 側欄資訊 | `ConversationPresentation.tsx`、`NativeConversationRows.tsx`、`ChatThreadTree.tsx`、`chatConversationSidebar.ts`、`chatWorkspaceNodes.ts`：相對時間及模型／CLI，完整供應商等資訊改放 hover |
| 局部時間更新 | `relativeActivity.tsx`：Intl.RelativeTimeFormat 與單一共用分鐘時鐘，只讓時間節點更新 |
| 文案與測試 | 繁中／英文訊息、選單互動、最近專案、時間更新、標題優先序及既有 render／interaction 測試 |
| 版面量測 | 新增 `scripts/composer-sidebar-layout.mjs`，保留既有連線卡片與側欄資料夾量測 |

## 選單行為

權限以 menuitemradio 表示目前選項，方向鍵、Home／End、Enter／空白鍵可操作。
Esc、Tab 與選取後返回觸發按鈕；點外部關閉且保留點擊目標的焦點。
執行中或已有待送內容時沿用既有停用條件；不新增 CLI 原本不支援的權限。

最近目錄來源為本機近期選擇紀錄、對話與原生紀錄的實際活動時間，
依時間排序，使用既有 project_directory_identities 的 canonical 路徑去重。
不同父路徑的同名目錄仍分開，並顯示路徑。
缺失、無權存取或無法確認的目錄停用；不把所有 canonical 失敗都宣稱為刪除。
選取前再次驗證，刪除或關閉後才完成的查詢不套用。
選單開啟期間固定候選快照，其他對話背景更新不重置搜尋。

本機最近目錄存在 latticeterm.recentChatProjects.v1，最多保留 64 筆路徑與時間；
顯示最多八筆，搜尋可找其餘候選。檔案系統查詢最多 256 個候選，
不讀取機密、不建立資料夾；通道、連線與 CLIProxyAPI 設定不變。
既有後端對外部／UNC 等無法安全確認的路徑仍會拒絕，選單不繞過限制。

## 標題與時間

自訂名稱即使剛好等於 CLI 名稱，也保有最高優先序。
群組不再重複顯示成主要標題下的小晶片；完整標題有 title 與 aria-label。
只顯示能對上目前帳號設定的名稱，不把本機設定目錄當成帳號名稱。

一般對話用 updatedAt（毫秒），原生紀錄用檔案活動時間（秒轉毫秒）。
可配對的 PTY 列沿用這些時間；未有時間的列只顯示模型或 CLI。
不把列被選取或背景輪詢時間當成最後活動。未讀與執行中指示保留。
分鐘時鐘由所有時間元件共用，最後一個取消訂閱後停止，不使父列重繪。

## 驗證

- typecheck／tsc、正式 build（含入口大小檢查）：通過。
- 全部 Vitest：2680 通過、0 失敗、3 略過。
- cargo test：1202 通過、0 失敗、65 ignored（含整合測試）。
- clippy --all-targets（warnings 視為錯誤）、fmt：通過。
- 新撰寫區／側欄 Chromium：144 通過、0 失敗。
- 既有連線卡片 Chromium：144 通過、0 失敗。
- 既有側欄資料夾 Chromium：144 通過、0 失敗。

新量測使用實際元件的合成內容及相同選單 CSS，涵蓋六主題、
320／760／1280 寬度、桌面／行動樣式、選單開關及兩倍文字，
確認無橫向溢出、彈出區在視窗內、三個假名稱的完整可見寬度。
既有資料夾量測繼續驗證任務 28 的名稱寬度與 hover／focus／觸控規則。
本次未修改 Rust，仍執行原生測試、clippy 與 fmt。

## 實機界線

本次未更新或重啟已安裝 App，未讀取正式帳號或真實專案目錄。
仍需實機確認系統資料夾選擇器返回、不同平台 WebView 的焦點行為、
觸控操作及原生 Codex 對話標題。未知時間、無法驗證路徑與未對上的帳號
均保守顯示，不以假資料補足。
