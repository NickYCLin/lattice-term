# 任務 13：排序選單與連線工具列一致

## 修正

`storybook.css` 原先把 `.select` 視為輸入控制項，但排序欄位的
`.select` 實際是 label，導致標籤與選單外面多出 2px 深色方框。

將主題邊框選擇器改為 `select.select` 與 `.select select`，同時支援
直接掛 class 的表單選單、包裝 label 內的原生選單，不再對 label
套上邊框。一般表單仍保留繪本主題的 2px 控制項邊框。

`connections.css` 將排序、SQL 工作台、匯入／匯出與分類分段按鈕的
外層控制框統一為：

| 屬性 | 使用值 |
| --- | --- |
| 高度 | `calc(1.875rem * var(--interface-text-scale))` |
| 邊框 | `1px solid var(--control-line)` |
| 圓角 | `var(--radius-pill)` |
| 背景 | `var(--surface-raised)`，hover 使用 `--surface-active` |
| 焦點 | `2px solid var(--focus)`、offset 2px、不疊加另一份陰影 |

分段按鈕仍保留原本的選取色；內部按鈕不再以最低高度撐大工具列。
工具列的 focus 選擇器優先於後載入的通用按鈕焦點樣式，確保原生
select 與按鈕一致。繪本主題針對工具列原生 select 使用相同 1px
邊框；label 不加邊框。行動版的工具高度至少 2.75rem，並保留既有
原生 select 字級設定。沿用原生 label／select，不另加元件抽象，
排序資料、事件與鍵盤操作未變動。

## 驗證與邊界

- CSS 測試確認繪本邊框只選到兩種原生 select，不含裸 `.select` 包裝。
- 工具列測試確認共用高度、圓角、背景、邊框、focus 及行動版尺寸。
- TypeScript、正式前端建置通過；相關 Vitest 30 通過、0 失敗；
  完整 Vitest 2,518 通過、0 失敗、3 項既有跳過。
- 無 Rust 修改，未變更 CLIProxyAPI 設定或正式資料，未發版或更新安裝版。

仍需在安裝版確認各主題、一般／緊湊密度、字級縮放與行動版下的
實際對齊、邊框及 focus 排版；原生下拉清單的外觀亦受平台 WebView
與作業系統影響。自動測試不代表上述實機畫面已驗收。
