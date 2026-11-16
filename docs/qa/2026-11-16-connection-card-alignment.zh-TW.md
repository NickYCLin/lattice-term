# 連線卡片按鈕列對齊驗收

## 規則與原因

原本連線方式數量放在可換行的按鈕 flex 容器，合併資料庫卡片又有另外一組
換行規則，造成同列卡片的按鈕區高度不同。現在統一採用以下結構：

1. 標題區：名稱及主機各一行，超長截斷，以原本 title 保留完整內容。
2. 標籤區：環境、協定與 SQL 徽章。
3. 彈性描述區：資料庫名稱與使用者標籤；沒有內容時仍保留這個 grid 區域。
4. 分隔線與按鈕列：固定兩個按鈕欄位及最右方的收藏星號欄位，單按鈕也不移位。
5. 底部資訊列：連線方式數量移至獨立固定高度區域；沒有內容時保留空列並 aria-hidden。

外層 connection-grid 明確 stretch；卡片的描述區使用 1fr 吸收同列高度差，
按鈕列與底部列從底部對齊。每一列依該列內容等高，不強制不同列具有相同高度。
按鈕與星號使用同一高度 token，標籤過長時截斷並保留 title；手機另保留至少
2.75rem 的觸控高度。顏色、間距及字級沿用主題 token，不限定奶油繪本。

## 修改檔案

- ConnectionCard.tsx：固定描述與底部區域、資料庫說明位置、按鈕完整標題。
- connections.css：五區 grid、固定按鈕欄位、高度與星號位置、主機截斷。
- database.css：移除合併資料庫卡片另外套用的按鈕換行規則。
- ConnectionCard.render.test.tsx、connections.css.test.mjs、mobileConnections.css.test.mjs：
  更新結構、空列、共用規則及手機回歸斷言；原本選單互動測試繼續通過。
- scripts/connection-card-layout.mjs：以正式元件 SSR 與完整正式樣式量測 Chromium 版面。

獨立資料庫卡片在另外的清單區塊，沒有與遠端卡片混排；本次調整的是包含
「開啟 SQL」的遠端／合併連線卡片，不改變連線、收藏、SQL 或選單 callback。

## 驗證

- 相關 Vitest：43 通過、0 失敗。
- 全部 Vitest：2,570 通過、0 失敗、3 略過。
- npx tsc --noEmit、npm run build 與入口大小檢查通過。
- npm run build:sidecars、全部 cargo test：1,189 通過、0 失敗、64 ignored。
- Chromium：144 組通過、0 失敗；桌面／手機 CSS 模式 × 六種主題（含 Mist、
  奶油繪本）× 一般／緊湊密度 × 320／760／1280 寬度 × 100%／200% 字級。
- 合成卡片涵蓋單／雙按鈕、有／無資料庫說明、有／無底部數量、長名稱／主機、
  多行標籤與不可連線狀態；同列高度、分隔線、按鈕頂端、底部列、第一欄起點與
  星號右側距離的差異均不超過 0.75 CSS px，無卡片或頁面水平溢出。
- 已檢視奶油繪本 1280px 合成截圖。未操作真實連線或讀取使用者連線設定。

重跑：`node scripts/connection-card-layout.mjs`。需要已安裝的 Chromium，
可用 CHROME 指定執行檔；腳本也會搜尋 Linux Playwright cache。
CARD_LAYOUT_SCREENSHOT 與 CARD_LAYOUT_RESULTS 可指定輸出圖片／JSON。
本機 IAB 無可用連線，改用獨立 Chromium；此主機限制 user namespace，僅此次
無帳號合成測試透過 CHROMIUM_NO_SANDBOX=1 啟動，不修改正式程式或系統設定。

仍需 Windows／macOS WebView 與安裝版的實際字型、縮放及原連線清單確認。
本次沒有發版、更新安裝版或打 tag，Chromium 合成驗收不等同所有平台實機驗收。
