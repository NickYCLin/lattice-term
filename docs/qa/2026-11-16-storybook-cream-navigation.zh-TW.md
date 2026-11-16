# 奶油繪本側邊導覽配色

## 修改範圍

| 選擇器／token 區塊 | 調整 |
| --- | --- |
| `:root[data-theme="storybook"] .rail` | 冷色 `#e8f2f5` 改用 `--canvas-deep`（`#f3ecdf`） |
| `.theme-option__preview[data-theme="storybook"] .theme-option__rail` | 使用相同 `--canvas-deep`，預覽與正式導覽一致 |
| `:root[data-theme="storybook"] .chat-thread.is-active` | `--storybook-blue` 改為奶油金 `--surface-selected`（`#fae4b4`） |
| `[data-theme="storybook"]` | 將 `--accent-soft`、`--info-soft` 指向 `--canvas-deep`；`--text-faint` 加深至 `#625b54` |

搜尋整份樣式後，其他大面積的偏藍色底來自共用 `--accent-soft`，例如
資料庫提示、對話拖放區與選取區；藉由主題 token 一併轉成奶油色。
`--info-soft` 的資訊狀態底也同步。深藍文字、細線、圖示與小型狀態標記
繼續作為強調色；其他主題、終端 ANSI 色彩及遠端螢幕內容不變。

## 對比度

依 sRGB 線性化及相對亮度公式計算，CSS 測試檢查普通、次要、淡文字與
accent 四種字色，對八種實際導覽／選取底色的 32 組組合均至少 4.5:1。
原本 `--text-faint` 在新 rail 底上約 4.34:1，改深後為 5.69:1。

| 底色 | 普通文字 | 次要／淡文字 | accent 文字 |
| --- | --- | --- | --- |
| 奶油導覽 `#f3ecdf` | 9.56:1 | 5.69:1 | 5.72:1 |
| 選取對話 `#fae4b4` | 9.00:1 | 5.35:1 | 5.39:1 |
| 黃色強調按鈕 `#f6d27a` | 7.71:1 | 4.59:1 | 4.62:1 |

## 驗證界線

TypeScript、正式建置、相關 Vitest 與完整 Vitest 通過。新增
`src/styles/storybook.css.test.mjs`，避免正式 rail 與預覽回到冷色、確認
選取與柔和背景為暖色，以及守住上述文字對比度。

隔離 Chromium 使用正式 CSS 和合成導覽／對話／預覽結構檢查畫面，
computed background 確認 rail、preview、soft、info 均為
`rgb(243, 236, 223)`，選取對話為 `rgb(250, 228, 180)`。
這是 CSS 視覺驗證，不是已安裝應用程式的實機結果。

本次沒有 Rust 修改，未更新安裝版、重啟現有 CLI、發版或打 tag。
仍需在更新後的桌面確認實際導覽列、選取對話、主題預覽，以及不同螢幕
縮放下的閱讀感受。未變更正式資料庫或代理設定。
