# 2026-10-14 桌面連線、對話副標與圖片驗收

## 範圍與來源

- 基線：`b6a0f4e3c432971fb5341319d5709c30de6673b0`。
- 實看使用者提供的連線卡、對話副標、終端圖片標記及卡片尺寸截圖；
  私人截圖不納入儲存庫。
- 僅修改本輪四項需求與回歸，沒有重啟現行桌面／MCP、改安全或分享設定、
  使用真實帳密、外部協定連線、發布或部署。
- GUI 使用現有隔離 Xvfb、私人 D-Bus、HOME／XDG／TMP、合成 PNG 與假 Aider。
  不附掛現行 display，也不讀取真實對話。測試按 nonce 與精確 PID 清理。

## 一、同主機多路線

### 原因與修正

既有 `machineId`、卡片合併與 Inspector 連結功能可表示多條路線，
但 Drawer 的協定選擇只會編輯同一筆紀錄。不能把切換協定當成新增連線方式。

- Drawer 與 Inspector 增加「新增連線方式」，Drawer 可切換已連結路線。
- 新增路線產生獨立 ID，以既有 `machineId` 連結；沒有既有群組時採來源 ID。
- 各路線分別保留 port、username、協定參數及帳密紀錄。
  不複製來源路線的 secret、deviceId 或 relayAddress。
- Rust 在同一儲存鎖中驗證來源和新 ID，一次寫入來源／新增路線；
  不分兩次更新以免半套連結。
- 尚未儲存的編輯在切換路線前確認；返回繼續編輯保留草稿，
  儲存失敗保留 Drawer，重複提交只執行一次。
- 沿用既有個別路線連線、解綁與刪除入口，沒有改匯出格式或將帳密加入檔案。

### 證據

- `connectionRoutes`：新協定預設、五種既有協定、編輯與順序、非法／重複 ID。
- Drawer interaction：儲存失敗重試、重複提交、切換取消／放棄。
  此層使用合成 credential hook，不等於真保管庫驗證。
- `useWorkspace.routes`：假 IPC 儲存失敗、重新載入、解綁／刪除與重複操作。
- 額外重現「儲存 IPC 未回覆，但 refresh 已讀到新增路線」的競態：
  原本 React updater 再驗新 ID 而拋錯。red 為 1 failed／1 passed，
  修正保留已刷新結果後 2 passed，不覆寫其他新增紀錄。
  `/tmp/lattice-route-refresh-race-before.log`、`...-after.log`。
- Rust storage 14 項通過，含重新開啟兩路線參數與原子寫入失敗不變更。
  `/tmp/lattice-routes-storage-actual.log`。
- Chrome 實際 App 的樣本資料頁可開 Drawer，無前端例外；已實看
  `/tmp/lattice-route-browser-qIs6hr/after.png`。
  此頁使用 browser fallback，不等於原生 IPC 或帳密驗證。
- 原生隔離 GUI 真鍵盤建立 SSH／SFTP 路線、Escape 取消、重複保存；
  直接讀隔離 `connections.json` 確認只有兩筆、相同 machineId，
  SSH port 2222、SFTP port 22。`/tmp/lattice-desktop-new-ui-keyboard.log`。
  後續接續剪貼簿時 OCR 未看到 quick-chat，不能把該整輪稱為通過。
- 最終分開執行路線驗收，`/tmp/lattice-route-gui-final.log` 通過；
  `/tmp/latticeterm-clipboard-e2e.q0xaME` 保留隔離 JSON 與 DOM 證據。
  指令：
  `LATTICETERM_E2E_KEEP=1 LATTICETERM_E2E_ROUTES=1 bash scripts/linux-clipboard-e2e.sh`。

### 尚未驗證

五協定的真實遠端服務、真帳密保管庫／配對、安裝版重新啟動，
及所有匯入匯出 UI 組合均未實機驗證。既有格式相容由 storage／既有回歸驗證，
不宣稱已完成外部連線全驗。

## 二、對話副標

### 原因與修正

原畫面混合 catalog 的 `OpenAI Codex`、直接 API 的 `Codex API`、
模型值與專案 basename，沒有顯示欄位意義；live／native／imported 的來源也不同。

- 統一副標欄位：來源、模型、連線端點、帳號、專案。
- Codex 終端／原生對話標 `Codex CLI`；直接 API 對話標 `Codex API`。
  使用 API endpoint 的 CLI 仍是 CLI，不因 endpoint 而改成直接 API。
- 模型缺值顯示「模型: 預設」，不是猜測某一模型；原生歷史未提供模型亦如此。
- 自訂 endpoint 保留 `cliProxyLabel`；找不到設定的 endpoint 顯示 `CLIProxyAPI`。
- 使用者對話名稱、persisted label、primary node ID 與側欄 identity 不變。
  長副標可透過 title 查看完整內容。

### 證據與限制

合成資料涵蓋 CLI／API、長端點、缺模型、Windows 專案、帳號、未知 CLI fallback、
live node identity 與自訂名稱。既有 ChatView render／原生清單回歸一併通過。
未登入付費供應商，也不宣稱截圖中的模型或端點已做真實 API 呼叫。

## 三、終端已送出圖片

### 原因與修正

基線已有 `SentAttachments`、`ChatImagePreview`、`AgentSessionImages`、
原生歷史圖片解析與受限本機 preview cache；本輪不是重做聊天面板上傳功能。
終端文字 `[Image #n]` 原本沒有通往 gallery 的點擊入口。

- 註冊 xterm link provider，辨識目前實體行內的圖片標記。
- 點擊開啟該 session 的既有圖片 gallery，再選圖檢視。
  不假設標記編號等於 gallery 索引：歷史匯入／去重順序不保證相同。
- 重用本機附件引用與安全 bounded cache，不公開上傳圖片，也不擴大讀取權限。
- 關閉後可重開，切換 session 不會自動開啟另一段附件。

### 證據與限制

- marker 回歸涵蓋多圖標記、中文寬字元位置、非法標記及缺行。
- gallery interaction 涵蓋 close／reopen、inactive／session 切換。
- Rust 原生歷史圖片 5 項通過：範圍限制、缺歷史保留 cache、數量上限、
  大型圖片紀錄及不假設編號。`/tmp/lattice-images-native-tests.log`。
- 原生隔離 GUI 真 X11 Ctrl+V 傳入 2048×1536 PNG，暫存權限 0600；
  真滑鼠點 xterm marker 後 DOM journal 出現「圖片附件」，
  原生 preview 讀回圖片 `loaded=true`、2048×1536。
  `/tmp/latticeterm-clipboard-e2e.Tu9p6Z/frontend-events.jsonl`。
- 上述 PNG／DOM 證明點擊與讀圖路徑，不代表 X11 screenshot 成功繪出 overlay。
  同環境 xterm canvas／Drawer overlay 漏繪；Drawer DOM width 672 且無例外，
  Chrome 對照能繪出 Drawer，未將此環境差異誤判為 App 沒開視窗。
- 最終 `/tmp/lattice-terminal-image-acceptance.log` 完整通過：真滑鼠 marker、
  關閉／移出再移入重開、依隔離 DOM 量測位置點圖片、preview 再 Escape 返回，
  journal 確認原生 2048×1536 圖片成功載入；最後中斷移除 PTY／暫存 PNG。
  原先固定座標／Tab 猜測沒有選到圖片，已改為量測 tile 位置而非假定通過。
  `/tmp/latticeterm-clipboard-e2e.GJF0mu` 保留最終證據。
  指令：`LATTICETERM_E2E_KEEP=1 LATTICETERM_E2E_DESKTOP_UI=1 bash scripts/linux-clipboard-e2e.sh`。
- 跨實體行折行的 marker 不解析，仍可用附件 toolbar。
  舊原圖／cache 已遺失時顯示不可用，不偽造圖片。
- 未重啟安裝版；多平台 GUI、窄屏大圖與正式 CLI 全部歷史格式未實機全驗。

## 四、連線卡片幾何

### 可重現原因

展開下方群組令容器出現傳統捲軸，捲軸占用寬度使同卡片與控制一起移動。
Chrome 載入真實 ConnectionCard markup 與完整 repo CSS：320 px 容器下，
卡片寬 296 → 286 px；連線按鈕 x 225.984375 → 215.984375，
actions x 193 → 183，高度維持 96.984375 px。
`/tmp/lattice-card-geometry-CDCKu2/geometry.json` 保存修正前量測。

### 修正與驗證

加入 `scrollbar-gutter: stable` 保留捲軸空間，沒有硬設卡片像素寬度。
真 browser 驗證單路線、五協定長名稱與不可連線狀態，
各在 320／480／760 px 容器反覆展開收合 10 次；
每次 card、全部連線按鈕與 actions 外框一致，沒有水平溢出。
`/tmp/lattice-card-multiroute-after.log`、
`/tmp/lattice-card-geometry-Oxo1se/geometry.json`。

回歸以 `LATTICE_GEOMETRY_BROWSER=/usr/bin/google-chrome npx vitest run scripts/connection-card-geometry.test.tsx`
執行，沿用 Chrome 原 sandbox；一般 Vitest 沒提供 browser 時明確 skip。
此層為真 CSS/browser 量測，不宣稱 macOS／Windows 安裝版 GUI 全驗。

## 本地檢查與二進位來源

- `npm run typecheck` 通過。
- 全部 Vitest：1632 passed／1 skipped（browser opt-in 幾何測試另行通過）。
- `npm run build` 通過，入口 360.22 KiB，小於既有 500 KiB 限制。
- Rust fmt／cargo check 通過；storage 14、原生 images 5 項通過。
  cargo check 仍有既有 GLib warnings，沒有為本輪修正其他 warning。
- 隔離 GUI 使用本輪 `cargo build --locked` 產物，不是只看舊 binary 存在。
  建置 log：`/tmp/lattice-routes-debug-build.log`；之後未更改 Rust。
  二進位 SHA256：`e9cd560309d4c083839cb6366972236c4245fb736c755161f75bfdff0b98e200`。
  基線上的 Rust diff SHA256：`104f0f6ff9682ccbd50e45c717a5ec1db9a12ec05dbcf2b50808c2762cd511d2`。
- log／合成附件在本機 `/tmp`，不提交 runtime 設定、daemon token 或帳號檔案。
- 本輪不重查使用者取消的 CI run，也不盲目重跑先前 iOS 診斷。
  遠端交付只追本輪新 commit；本地通過不代表遠端 CI 或安裝版已更新。
