# 任務 14：全 app 控制項樣式盤點

## 修改清單

| 檔案／區域 | 調整與理由 |
| --- | --- |
| `tokens.css` | 新增共用表單／精簡高度、邊框、圓角、選擇控制項尺寸、focus、停用透明度 token；繪本主題只覆寫表單框線寬度 |
| `controls.css` | `.input`、`.textarea`、所有原生 select 共用表面、邊框、圓角與狀態；不依賴 select 是否帶 class；一般按鈕與表單欄位共用高度 |
| `controls.css` | `.select` 包裝僅管排列；精簡選單共用高度；原生 checkbox／radio／range 共用強調色，checkbox／radio 共用尺寸；自訂 checkbox 連動 focus 與停用狀態 |
| `base.css`、`control-contrast.css`、`storybook.css` | focus 與停用值改用共用 token，刪除重複 focus 陰影與表單邊框規則，避免主題再替包裝標籤加框 |
| `database.css` | 刪除 DatabaseManager、SQL 權限選單、結果篩選的獨立控制項皮膚與箭頭；表單按鈕沿用共用高度及圓角，保留可換行排版 |
| `DatabaseManager.tsx`、`SqlResultTable.tsx` | 普通文字欄位、搜尋與唯讀內容加入共用 input／textarea class，取代對容器 CSS 的依賴 |
| `connections.css` | 音效 select 只留排列規則；工具列高度接共用精簡 token；移除重複 focus 與停用數值；使用 background-color 保留原生 select 的共用箭頭 |
| `chat.css`、`agents.css` | 對話設定與工作階段精簡選單改用共用高度；輸入列內嵌權限 select 明確重設尺寸，焦點由外框顯示，避免雙重 focus 框 |
| `HerdrPane.tsx`、`ProjectLaunchSettings.tsx` | 原先無共用 class 的普通文字欄位與多行文字接上共用樣式 |
| `mobile.css` | 一般欄位高度跟隨行動版 control-height，且不小於 2.75rem；保留原有原生控制項字級與特殊輸入列布局 |
| `remote.css`、`sftp.css`、`shell.css` | 停用透明度採共用值，移除與共用停用游標相反的覆寫；忙碌中的 SFTP 列仍保留 progress 游標 |
| CSS 測試 | 更新精簡工具列及繪本邊框測試，新增共用表單、focus、fieldset 停用、選擇控制項及內嵌變體測試 |

表單高度跟隨密度及字級；精簡工具列、圖示按鈕與多行文字各有合理
的尺寸變體，不將全部互動強制做成同一高度。錯誤欄位保留危險色
邊框及 focus；停用樣式同時涵蓋原生 disabled、fieldset disabled
與 aria-disabled，沒有變更事件回呼或權限判斷。

## 29 個 select 使用檔案逐一核對

原生 select 的共用 skin 直接匹配元素，因此不需要逐檔加入新元件。
以下檔案均已檢查既有 class 與局部樣式；表內未列為變體的選單，
都使用共用表單尺寸、箭頭、圓角、邊框、focus 與停用狀態。

| 檔案 | 覆蓋方式／保留變體 |
| --- | --- |
| `DatabaseManager` | 無 class select 由共用元素規則涵蓋；刪除資料庫獨立皮膚 |
| `SqlWorkbench` | 無 class SQL 權限 select 改用共用皮膚；SQL 編輯器仍是專用等寬輸入區 |
| `ConnectionInspector` | `select.select`；僅保留可縮窄的 flex 排列 |
| `ConnectionDeleteDialog` | `select.select`；保留危險操作流程 |
| `ConnectionMergeDialog` | `select.input` 同樣使用共用箭頭及狀態 |
| `ChatView` | 推理 select 用一般表單；權限 select 為輸入列內嵌變體，由外框顯示 focus |
| `ChatDelegations` | 三種 `select.select` 共用表單 |
| `AutomationPane` | `select.select`，含 is-invalid 的錯誤框線與 focus |
| `AccountModelField` | 來源、模型皆為 `select.select`；載入、帳號缺失及停用流程不變 |
| `ChatInputSettings` | 兩種送出偏好均為 `select.select` |
| `NotificationSoundPanel` | 無 class select 改用共用 skin，sound-event 僅處理 grid 排列 |
| `ChatTools` | `select.input` 共用箭頭；工具面板布局不變 |
| `ChatChangesPanel` | `select.input` 共用皮膚 |
| `McpElicitation` | `select.select`；checkbox 多選保留原生語意及驗證 |
| `ModelField` | `select.select`；既有模型編碼與選擇不變 |
| `HerdrPane` | 無 class select 共用 skin；普通文字欄位補 input class |
| `AgentsView` | 一般 `select.select`；工作階段列與 pacing 選單使用共用精簡高度 |
| `AgentSkillsPanel` | 目標與來源 select 共用表單 |
| `RemoteFleetPanel` | `select.select`；保留行動版觸控下限 |
| `ConversationHandoffDialog` | `select.select`；交接流程不變 |
| `JevAdvisorPanel` | `select.select`；忙碌與載入狀態不變 |
| `AgentRemoteDelivery` | `select.input`；檔案選擇器不套一般欄位皮膚 |
| `ProjectLaunchSettings` | 無 class select 由共用規則涵蓋；原生 checkbox 共用強調色，多行欄位補 class |
| `SessionPermissionField` | `select.input`；保留提示關聯與權限限制 |
| `FileNameFilter` | `select.select`；保留檔案工具列的 44px 觸控下限 |
| `RemoteCommandPane` | 兩種 `select.input` 共用表單 |
| `VaultView` | `select.select` 共用表單 |
| `ConnectionsView` | label.select 僅排列，內部 select 採精簡工具列；標籤不加框 |
| `TunnelsView` | `select.input.select` 只套一份共用框線與箭頭 |

## input、checkbox、radio、按鈕的保留邊界

- 一般文字、密碼、數字、網址、時間欄位沿用 `.input`，不是依型別
  全域強制替所有 input 加表單外框。DatabaseManager 的普通輸入欄位
  已補齊 class，避免依賴特殊容器皮膚。
- 搜尋列內嵌輸入、對話 textarea、SQL 編輯器與畫布軟鍵盤接收器
  保留其複合布局；不替隱藏 file input 或 xterm 文字接收器加外框。
- 原生 checkbox／radio 保留平台勾選符號、checked、fieldset、表單
  與輔助工具語意，不另外以 JS 重畫；共用尺寸、強調色與焦點規則。
  自訂 `.checkbox__box` 使用同組尺寸、圓角、邊框及 focus token，
  隱藏的真實 input 仍維持透明與零尺寸。
- 選擇卡片／分段按鈕的選取背景與結構性邊框仍屬其元件狀態，使用
  既有主題 token。已選取而不能再選的移動目的地仍維持完整顯示；
  這與工具因不可用而停用的狀態不同。

## 驗證結果

- TypeScript 與正式前端建置通過。
- 相關 Vitest：115 通過、0 失敗；其中 CSS 單獨執行為 38 通過、0 失敗。
- 最後完整 Vitest：2,522 通過、0 失敗、3 項既有跳過。
- IAB 無可用 backend，改用獨立無頭 Chromium 與合成 HTML，載入
  實際完整 CSS；沒有載入任何帳號、主機資料或正式資料庫。
- 6 主題 × 2 密度 × 桌面／行動 CSS 共 24 組，失敗 0；確認一般
  欄位幾何與背景、兩種 class 及無 class select、箭頭、工具列、
  label 無框、fieldset 停用、隱藏 input、內嵌變體、按鈕及 select
  focus、自訂 checkbox 停用外框與原生滑桿強調色。
- 合成樣本關閉動畫以比對穩定的 CSS 計算值；奶油繪本樣本已截圖
  檢視。暫存證據：`/tmp/lattice-task14-preview/results.json`、
  `/tmp/lattice-task14-preview/controls.png`。
- 無 Rust 修改，未變更 CLIProxyAPI 設定、正式資料或密碼／金鑰；
  未發版、更新安裝版或重啟使用中的 CLI。

## 仍需實機確認

所有實際頁面的窄視窗、長選項、字級縮放、鍵盤 focus、停用與錯誤
欄位排列；系統原生下拉清單、核取／單選符號；Windows、macOS、
Linux 與行動版 WebView 的呈現與軟鍵盤。Chromium 合成樣本檢查
不能等同於所有安裝版頁面或真實裝置已驗收。
