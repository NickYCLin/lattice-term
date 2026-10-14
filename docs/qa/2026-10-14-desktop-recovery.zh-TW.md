# 桌面補漏、音效恢復與設定容器驗收

日期：2026-10-14。基線 `ff216e6835964a9e9f16d52fcdd9bb988824c0e5`。
PR #308 已合併；本輪承接第 5～11 項補漏與第 12／13 項，
不重做第一批功能、不重啟現行桌面／MCP、不發布或部署。
所有新增測試使用合成資料、mock IPC 或臨時目錄；不改 OS 設定、
分享權限、ACL，不讀受限會話、不進行真實遠端傳檔或永久刪除。

## 確定缺陷與修正

### 第 5 項：標準 MCP 圖片結果

- 基線 `encoded_image` 只辨識 Claude `source.base64` 與 Codex data URL，
  標準 MCP `{type:image,mimeType:image/png,data:base64}` 被漏掉。
- 新增完整 function call／tool result 合成回歸，含上述三種格式與
  一個外部 URL；red 只有兩張，修後三張。外部 URL 不下載。
- 保留工具名稱、call ID／step ID、工具結果時間；舊 cache 缺 step ID
  仍可讀。gallery 顯示可得的 step ID，使用者附件與觀察圖片仍分區。
- `transcript::images` 9 項通過；既有 observed 專用 prefix、相同像素
  不改分類、hash／路徑／權限及缺歷史 cache 回歸保持通過。
- 證據：`/tmp/lattice-recovery-mcp-before.log`、
  `/tmp/lattice-recovery-mcp-after.log`。沒有像素／缺原檔的文字標記
  仍不可重建畫面；本機引用仍不是保證保存了當時檔案版本。

### 第 9 項：封存狀態在窄屏可操作

- 不重修已完成的桌面 aside 佈局；窄屏驗收另發現 720px 以下
  `.chat-threads {display:none}` 會把其中的錯誤重試與還原一起隱藏。
- 抽出共用 `ChatArchiveStatus`，桌面仍在 aside；窄屏於 chat main
  顯示同一狀態，限定高度並可捲動。隱藏版本不可鍵盤聚焦。
- 320／760／1000px 產品 CSS 與真實狀態元件幾何無水平溢出，
  每寬度滑鼠重試、鍵盤 Enter 還原均觸發正確 callback。
  fixture 的前後幾何保存在本機 GUI evidence；不等同完整 App／真 RPC。
- hook 回歸另外斷言封存→還原保留原 native thread ID、專案與帳號；
  還原兩次呼叫均沿用原合成 account root。失敗保留狀態、雙擊去重。
- 實作界線：官方同 host／帳號的 archive／unarchive RPC、持久
  start `ephemeral=false`、exact-ID resume 已實作及合成驗證。
  未操作真 Codex Desktop；雙側列表可見／外部刷新／重開接續、
  離線重連與跨側並行仍未真桌面驗證，不能宣稱完整雙向同步。
  還原 receipt 是本視窗近期操作，不是永久歷史回收桶。

### 第 11 項：寫入階段與權限拒絕

- 已修正文案不再說所有拒絕都「沒寫 payload」，本輪不重改文案。
- create 前 fstat 失敗／mode 不符、缺 mode、碰撞及清理失敗，
  合成 server 斷言僅 open／fstat／close／remove，沒有 payload write。
- 新增已寫完 staging（456 bytes）的 publish mode 驗證失敗案例：
  server 回報不相容 mode，仍拒絕發布；abort 清理 staging，
  原檔 123 bytes 不變，transfer 保留 bytes_done 與真實錯誤。
- 既有 publish rename 失敗恢復原檔、restore 失敗保留可追蹤 backup、
  取消／碰撞／unknown outcome 回歸一起通過，SFTP tests 共 14 項。
- 沒有刪掉 owner-only 檢查；SFTP v3 mode 不是 Windows ACL 證明，
  未支援伺服器的安全私有寫入仍可能拒絕，不能稱真 Windows 已相容。

### 第 12 項：完成事件及播放器可恢復

- red 1：unavailable 仍寫成功合併時間，100ms 後 native 恢復被誤抑制。
  現在只於 native／WebAudio 成功回覆記成功時間，pending reservation
  防止同時重送；off 與 0 音量維持靜音。
- red 2：resume 永不 resolve 堵住全域 queue。resume 等待限 1.5 秒，
  逾時淘汰同一 context，舊 resume 日後完成不可排 oscillator；
  closed context 會重建，失敗後可播放下一個事件。
- native RPC 等待限 2 秒；逾時視為 unknown／unavailable，不再切
  WebAudio 造成可能雙播。立即 false／拒絕仍走既有 fallback。
  舊 promise 不可清掉新 pending lock 或回寫成功合併時間。
- 新事件層 red：`markAgentSessionClosed` 把關閉標成 done，原 helper
  會誤播。現在排除 closedReason 與新發現的歷史 done，保留已知
  live session 的 done transition。ChatCompletionTracker 原有
  failed／cancelled／restored／晚到事件排除回歸保持通過。
- 三層證據：
  1. **事件**：App shell 跨頁保留 listener；session transition 與 chat
     tracker 合成測試 7 項過。未用真受限 agent 任務驗前背景切換。
  2. **API**：播放器 12 項 mock 過，含恢復、timeout、晚 resolve、
     成功 burst 合併、native 拒絕 fallback、closed context、off／0。
     Rust catalog 3 項驗 PCM 長度／音量／靜音；不是外部音檔漏載。
  3. **真正可聽**：未驗，不宣稱聽到；未改 OS 音量／輸出路由，
     未發出測試聲。Windows `PlaySoundA` 同步＋Mutex 是 API 路徑，
     其成功回覆也不能證明裝置真的可聽。
- 已提交的 native OS 呼叫無法由前端 timeout 撤回；極端延遲後
  原生聲音仍可能發出。此修正解除前端阻塞且不追加 fallback，
  不是取消 OS 播放或證明使用者現場問題已根治。
- red／green：`/tmp/lattice-recovery-sound-before.log`、
  `...-sound-after.log`、`...-completion-event-before.log`、
  `...-completion-event-after.log`。測試全部無聲。

### 第 13 項：同類設定容器一致性

- 已實看開機啟動段未包卡片的參考圖；根 settings-section 原無樣式。
  改採既有 panel／glass／sheen、panel head／title；不改開機值。
- SettingsView 同類 panel 加範圍化 min-width／長內容換行。
  真 Chromium 窄屏 screenshot 另發現 text 被 segmented 擠成極窄欄；
  保留 13rem flex basis 讓控制自然換列，不硬設容器寬度。
- 盤點：BackgroundServicePanel、PrivacyNotice 與 startup 使用
  panel glass sheen；RemoteMcpPanel、CliProxyApiPanel 使用 panel glass。
  圓角、邊框、背景、內距及標題共同沿用 tokens；sheen 保留語意差異。
  NotificationSoundPanel、nested setting-list 保持父卡片，不重複套框。
- 320／760／1000px × light／dark，兩個同類 panel 均 1px solid、
  14px 圓角、16px 20px 內距，overflow 0。等主題轉場完成再量測。
  長合成英文／無斷詞、read error、busy、retry、Tab 與切換回覆可用。
  busy 與確認前後卡片高度不變；所有開機 IPC 是 fake，未改 registry。
- 元件 fake DOM 驗 class／title hierarchy、read／write failure／retry、
  pending 去重與 late result；GUI 使用真 React、鍵盤及產品 CSS。
  不是已安裝 Windows 桌面全驗。

## 第 5～11 項逐項收尾範圍

| 項目 | 本輪證據 | 仍未驗／限制 |
| --- | --- | --- |
| 5 觀察圖片 | MCP 三格式、tool／step／time、來源隔離、gallery Escape | 真供應商所有 live tool event；缺像素無法還原 |
| 6 摘要交接 | 共用元件缺 export 手填、跨 recipient、首次失敗重試成功、取消焦點返回、雙擊；兩頁接線核對 | 兩個完整 App 入口到真供應商、登入／額度；摘要不是原生 thread 同步 |
| 7 終端裁切 | 320／760／1280 真 xterm 幾何 overlap 0；主題／縮放回歸 | Windows 安裝版、真 PTY 重連 |
| 8 Skills | 200 項搜尋、source no-results／清除、details 滑鼠及 Enter 收合、Tab、切目標元件回歸 | 真帳號探索；未讀 Skill 指示 |
| 9 同 thread 操作 | 失敗保留、same ID／account restore、重試去重；窄寬狀態操作 | 真 Desktop 雙側可見／刷新／重開與離線並行 |
| 10 閃爍 | 20 write 多 1 fit、2.2 秒 idle 無新 render、10 次背景更新不 remount | 原 Windows 間歇閃爍未定位；未證明完整 App 跨頁 remount |
| 11 SFTP | create 拒絕不寫、publish 已寫 staging 拒絕清理、原檔／backup、UI stale empty 既有回歸 | 真 Windows mode／ACL、外部 host／MCP client 工具快取 |

MCP schema 有 SFTP 工具不等於當下存在共享 SFTP target；
`desktopSshSftp` 舊 capability 分組 ID 不是目前連線協定的證明。
本輪維持既有 ID／分享政策；既有文件修正不重做。

## iOS 白帶：未定位，不以 OCR 成功掩蓋

已沿主線 `ff216e6` 的三張原始 PNG 基準核對：iPhone／Pro Max
底部白帶 288 physical px，iPad 104px，iPad 右下另有弧形。
這在較早產物也存在，不歸因本批回歸；Connections 和六項導覽可見
只能證明啟動畫面，不是完整視覺通過。沒有裁切截圖或改驗收門檻。

源碼已有 viewport-fit=cover、safe-area padding、html/body/root 100%、
app 100vh；Cargo.lock 的 Wry 0.57.0 iOS 用 native view frame 建 WebView，
原生背景另有自己的設定。上述存在不能判定白帶究竟落在哪一層。
本機 Linux 無 CoreSimulator／UIKit，缺同時的 WKWebView／parent frame、
safeAreaInsets、DOM innerHeight／visualViewport／root rect 和原圖擷取
時序證據；不能區分 frame、CSS／safe-area、native 背景或未完成擷取。
不猜改背景色掩蓋；此項保持明確未定位，非阻擋其他確定修復。

## 可重現命令與本機證據

- `npm run typecheck`、`npx vitest run`、`npm run build`。
- `cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check`、
  `cargo check --manifest-path src-tauri/Cargo.toml`、
  `cargo test --manifest-path src-tauri/Cargo.toml --lib`。
- `LATTICETERM_E2E_CHROMIUM=/usr/bin/google-chrome node scripts/desktop-followup-e2e.mjs`。
  使用已存在 Chrome、私有 profile、localhost port 0、合成 IPC；
  未停用 browser sandbox、不接現行 display／帳號，僅清理自己程序。
- GUI 最新 `/tmp/lattice-followup-gui-gGCqdf/evidence.json`，
  同目錄 six settings screenshots 已保留；320px 修正前目視證據在
  `/tmp/lattice-followup-gui-foR1CF/settings-light-320.png`。
  公開合成量測副本：`evidence/2026-10-14-recovery-gui.json`。
- Rust 964 passed／38 ignored；frontend 1652 passed／1 skipped，
  build 入口 362.69 KiB／500 KiB；依賴 glib warnings 與 bundle chunk
  提示不冒稱本輪新增故障。平台忽略測試及安裝版邊界未驗。

## 遠端交付

待本輪精確 head 的 CI／Windows／iOS 完成後核對與合併。
只追本輪新提交，不查已取消舊 run；本文件保留未驗證邊界。
