# Lattice Remote 中繼伺服器（lattice-relay）

讓 Lattice Remote 做到「輸入九位數裝置 ID 就能連線」的自架服務。
被控端與檢視端都主動連到中繼站，由它把兩條連線接起來；NAT 後的機器
因此不需要開 port 或設定轉發。

## 安全邊界

- 中繼站**只轉送密文**。畫面、終端、輸入與檔案全程使用兩端之間的
  Noise（XXpsk3）端對端加密，配對碼從不經過伺服器。
- 伺服器磁碟上只有「裝置 ID → 註冊 token 的雜湊」。即使整台被拿走，
  也無法冒充裝置或解開任何工作階段。
- 公網入口必須使用 `wss://`，由 HTTPS 保護裝置註冊與尋址控制訊息。
  原生 TCP 沒有 TLS，只能放在可信任的私有網路或 VPN；畫面工作階段本身
  無論走哪種載體都仍由 Noise 端對端加密。
- 裝置 ID 由第一次註冊的 token 綁定，其他機器無法搶註同一組號碼。
  Agent 本機的永久身分檔包含註冊 token 與 Noise 私鑰，Unix 上會在建立
  與載入時強制修正為擁有者限定的 `0600`；不要把它放進同步空間或備份給
  其他使用者。
- 檢視端第一次連上某個裝置 ID 時會釘選該裝置的永久身分金鑰
  （trust-on-first-use）；之後金鑰不符會直接拒連，即使中繼站被
  掉包或有人搶到同號也冒充不了。裝置重灌後需在檢視端的
  `remote-device-pins.json` 移除該筆再連。
- 每個來源 IP 每分鐘最多 30 條新連線，阻擋透過中繼站暴力嘗試配對碼或
  掃描裝置 ID。直連的來源在 WebSocket 握手前就先檢查，被擋下的連線買不到
  HTTP 解析工作。
- 預設情況下 loopback 的連線不受此限——經 HTTPS/WSS ingress 轉送時所有
  公網流量的來源都是 127.0.0.1，共用同一個額度反而會互相卡死。代價是
  **這個限速對公網流量完全沒有作用**。加上 `--client-ip-header` 指定
  ingress 寫入真實來源的標頭（Cloudflare 是 `Cf-Connecting-Ip`，nginx
  常用 `X-Real-Ip`），loopback 連線就改記在該位址名下，限速重新涵蓋公網。
  沒開這個選項時，公網的來源限速必須在 ingress 另外設定（例如 Cloudflare
  WAF／Rate Limiting、nginx `limit_req` 或等效閘道能力），不能把 loopback
  豁免誤認成已有公網保護。
- `--client-ip-header` 只信任 loopback 對端送來的該標頭：直接連到這個
  port 的人送什麼都會被忽略，不能自己挑要花哪個額度。前提是前面的代理
  **覆寫**該標頭而不是把客戶端送的值接在前面；relay 取最後一個值，所以
  會附加的代理也安全，但完全不設該標頭的代理就等於沒開。標頭讀不出位址
  時該連線維持豁免，不會被記到猜出來的額度上。
- 中繼位址**不是機密**：兩端必須知道它，DNS、TLS 連線與本機設定也能看見。
  LatticeTerm 在成功保存後只顯示「使用已儲存的中繼伺服器」，是降低日常
  操作雜訊，不是以隱藏網址取代加密、認證或入口防護。

## 目前服務範圍

目前 `lattice-relay` 適合個人或小型可信任團隊自架，不是可直接開放大眾註冊
的多租戶 SaaS。它尚未提供帳戶／組織 ACL、裝置擁有權管理、管理員稽核、
每租戶配額、頻寬計費、封鎖清單、高可用或水平擴充協調。公開 WSS 位址上的
任何人都能送出連線與查找請求；真正建立工作階段仍需正確的配對密碼／隨機長碼與
相符的裝置金鑰，但營運者仍須在入口加上限速、連線數上限、監控與告警。

每台 Agent 同時只服務一位檢視端；中繼會雙向逐位元組轉送畫面、終端與檔案
流量，因此頻寬約等於所有進行中工作階段的總和，檔案上下載與高 FPS 畫面會
是主要流量，CPU 通常以 WSS 入口的 TLS 與連線管理為主。若要開放很多不互信
使用者，應先補齊上述租戶隔離與營運控制，不能只增加 VM 的 CPU／記憶體。

## 部署

```bash
scripts/deploy-relay.sh user@your-server [ssh-port]
```

腳本會在伺服器上安裝 Rust（若沒有）、編譯 `lattice-relay`、建立
`lattice-relay` 系統使用者與 systemd 服務，並安全地只監聽
`127.0.0.1:44910`。重跑同一指令即可升級；另以 Cloudflare Tunnel、
nginx 或 Caddy 把 HTTPS/WebSocket 入口轉送到這個位址。

手動操作時的關鍵指令：

```bash
cargo build --release --features relay-server --bin lattice-relay \
  --manifest-path crates/lattice-remote/Cargo.toml
lattice-relay --bind 127.0.0.1:44910 --state /var/lib/lattice-relay/devices.json \
  --client-ip-header Cf-Connecting-Ip
```

`--client-ip-header` 依前面的 ingress 而定：Cloudflare 用
`Cf-Connecting-Ip`，nginx 用你在 `proxy_set_header` 設的名稱（常見是
`X-Real-Ip`）。不確定前面會不會覆寫該標頭就先不要加，改在 ingress 做限速。

### 免費 Cloudflare Quick Tunnel

Relay 啟動後，在同一台機器執行：

```bash
cloudflared tunnel --url http://127.0.0.1:44910 --no-autoupdate
```

`cloudflared` 印出的 `https://隨機名稱.trycloudflare.com` 要在 LatticeTerm
填成 `wss://隨機名稱.trycloudflare.com`。Quick Tunnel 免費且不需要網域，
但程序每次重啟網址都會改，而且是 Cloudflare 定位為測試用途、沒有 SLA 的
臨時入口。`trycloudflare.com` 不是自己的網域，掛不上 WAF／Rate Limiting，
所以入口端補不了限速；relay 這邊請務必啟動時加上

```bash
lattice-relay --bind 127.0.0.1:44910 \
  --state /var/lib/lattice-relay/devices.json \
  --client-ip-header Cf-Connecting-Ip
```

否則所有公網流量都是 loopback，內建的每 IP 限速一條都用不到。即使如此，
Quick Tunnel 仍只適合自己測試，不應作為對外多人服務。要固定網址與可控的
入口政策，需使用掛在自己網域下的 named tunnel 或自行管理 nginx／Caddy。
Cloudflare 的限制以
[Quick Tunnel 官方文件](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
為準。

## 用戶端設定

- **被分享端**：「分享這台裝置」→ 分享方式選「透過中繼伺服器」，
  公網填入 `wss://你的伺服器`，私有網路可填 `你的伺服器:44910`。
  啟動後畫面會顯示永久的九位數裝置 ID 與
  配對碼；可設定 6～64 個字元的固定密碼（大小寫英文、數字、半形特殊符號），或每次分享自動產生長碼。
- **檢視端**：右上角「以 ID 連線」，輸入對方的裝置 ID、配對碼與同一台
  中繼伺服器位址即可。第一次成功使用後，位址會保存在這個安裝的前端本機
  儲存區，之後分享與連線畫面只顯示已儲存狀態；按「修改」仍可查看或更換。
- 連線成功的裝置會留在「我的連線」，之後從清單連線只需要輸入配對碼，
  不必再重打九位數與中繼位址。**配對碼是一次性密碼，不會被保存**。
  這筆記錄存的是裝置 ID 與中繼位址：兩者都不是機密，和其他連線設定檔
  一樣可以命名、分組、標籤與匯出。同一個裝置換到別的中繼位址時，
  下次連上會就地更新，不會多出一筆；你自己改過的名稱不會被覆蓋。
- **中繼位址換掉時**（Quick Tunnel 每次重啟都會換），連線對話框會在
  中繼沒有回應時就地打開位址欄位，填入新網址重連即可，不必先去編輯
  設定檔。只有真的連上的位址才會被寫回去，猜錯不會覆蓋原本可用的值。
  中繼有回應但拒絕（例如裝置離線）時不會出現這個欄位——那種情況位址
  是對的，要修的是另一端。
- **無畫面的純文字主機**（沒有桌面環境的伺服器）：在該機器上執行
  `lattice-agent --relay wss://你的伺服器 --terminal --allow-input`，
  分享的是加密的 shell 終端機而不是畫面；檢視端一樣用裝置 ID＋配對碼
  連線，開啟的會是終端分頁。不加 `--allow-input` 則對方只能看不能打字；
  `--file-root` 檔案分享照常可用。
- **從 Agent Fleet 內的 CLI 操作**：桌面版會把內附的用戶端絕對路徑放在
  `LATTICETERM_REMOTE_CLI`。PowerShell 以
  `& $env:LATTICETERM_REMOTE_CLI --relay ... --device ... list /` 呼叫，sh 則以
  `"$LATTICETERM_REMOTE_CLI" --relay ... --device ... list /` 呼叫；另有
  `upload LOCAL REMOTE`、`download REMOTE LOCAL` 與 `terminal`。用戶端不接受
  命令列配對碼，未指定 `--pair-code-file` 時只在互動終端隱藏詢問。上傳多檔
  部署時建議先打成一個 release 封裝，上傳後再進入互動終端驗證 SHA-256、
  解壓與切換服務；不提供背景 `exec` 字串入口。
- **無人值守（固定配對碼）**：桌面內嵌分享不會保存固定碼，並以 stdin
  交給 Agent；可用 6～64 個字元的固定密碼或隨機長碼。獨立常駐服務應放在只有服務帳號可讀的檔案，改用
  `--pair-code-file`，避免秘密出現在程序清單。先在 Agent 帳號下建立檔案：

  ```bash
  install -d -m 700 ~/.config/lattice-agent
  pair_code="$(openssl rand -hex 16)"
  (umask 077; printf '%s\n' "$pair_code" > ~/.config/lattice-agent/pair-code)
  unset pair_code
  ```

  然後常駐啟動 headless 主機：

  ```bash
  lattice-agent --relay wss://你的伺服器 --terminal --allow-input \
    --pair-code-file ~/.config/lattice-agent/pair-code \
    --file-root ~/LatticeTermShare
  ```

  `--file-root` 請指向專用交換資料夾，不要直接分享整個家目錄。連續五次
  配對失敗後 Agent 會正常停止；systemd 不要使用 `Restart=always`，否則會
  不必要地反覆重啟。新版另有跨程序、重啟後仍有效的十分鐘五次配對限制。
  命令列 `--pair-code TOKEN` 可接受同樣的固定密碼或長碼供臨時手動
  測試，但值可能被其他本機使用者從程序參數看見，不適合常駐服務。

## 協定摘要

單一監聽連接埠（預設 44910）同時接受原生 TCP 與 WebSocket upgrade；
兩種載體內都是 `u32` big-endian 長度前綴的 JSON 控制訊息：

| 訊息 | 方向 | 作用 |
| --- | --- | --- |
| `register` | agent → relay | 以 deviceId + authToken 註冊並保持連線收邀請 |
| `invite` | relay → agent | 有檢視端要連入，附 channelId |
| `join` | agent → relay | 開新連線回應邀請 |
| `dial` | viewer → relay | 以 deviceId 找裝置 |
| `linked` | relay → 雙方 | 之後所有位元組盲目互轉 |
| `ping` / `pong` | 雙向 | 控制連線保活（25 秒） |

`linked` 之後即為既有的 Lattice Remote 加密協定，與直連模式完全相同。

命令列檢視端與桌面檢視端使用同一份 `remote-device-pins.json`。只有在 Noise
配對完成且收到 Agent 的加密 Hello 後才會寫入第一次看到的永久金鑰指紋；
後續不同金鑰會拒絕連線。釘選檔只含公開指紋，寫入仍使用跨程序鎖與同目錄
原子替換，避免 GUI 與 CLI 同時首次連線或程序中斷時遺失既有信任記錄。

## 版本相容

**桌面版與遠端主機不必使用相同的應用程式版本。** 只用來被連線的主機，
可以保留原本的版本；是否能連線取決於遠端協定與裝置身分，不比對版本字串。

| 遠端主機 | 這個版本的連線方式 | 是否需要更新主機 |
| --- | --- | --- |
| v4 密碼握手、訊息協定 v2 | 固定密碼或自動長碼，保持相容模式關閉 | 兩端都須支援 v4 |
| 使用 32 位十六進位配對碼、舊 v3 握手、訊息協定 v2 | 勾選舊版相容模式，直連或裝置 ID 沿用原配對碼 | 不需要 |
| 使用八位數碼、舊握手、訊息協定 v2，且這台電腦已有該裝置的信任紀錄 | 勾選舊版相容模式，用原裝置 ID 連線，先核對永久裝置金鑰 | 不需要 |
| 使用八位數碼，但沒有既有信任紀錄 | 使用曾信任該裝置的電腦連線；若無可用紀錄，須先更新主機建立新配對 | 不能直接略過身分確認 |
| 使用八位數碼的 IP 直連 | 舊直連使用暫時身分金鑰，無法用既有裝置 ID 紀錄核對 | 改用已信任的裝置 ID，或更新主機 |
| 訊息協定不在支援範圍 | 顯示無法溝通的協定與需更新的一端 | 視協定而定 |

舊版相容只加在檢視端，桌面版和 `lattice-remote` CLI 共用同一套驗證。
舊配對碼可由連線視窗輸入、從系統認證儲存區讀取，或由 CLI 的
`--pair-code-file` 讀取，另加 `--legacy-pairing`；不必更換主機端的常駐服務或設定。
信任紀錄位於使用者資料目錄的 `remote-device-pins.json`，CLI 也可指定
`--pins-file` 讀取既有紀錄。清空或刪除紀錄不會讓舊裝置變得可信任。

新版分享使用 OPAQUE 密碼握手，再建立 Noise 加密通道；固定密碼支援大小寫、
數字及特殊符號。連線端只有明確選用相容模式時才使用舊握手，八位數碼另需
既有裝置指紋；不會因新握手失敗自動重試舊方式。詳見[固定配對密碼](PAIRING_PASSWORD.zh-TW.md)。
驗證在 Noise XX 第二個訊息後、送出第三個訊息的配對證明前完成；
金鑰不符立即中止，避免向冒充裝置送出可供離線猜碼的證明。
握手與配對後仍必須收到加密 Hello，才會建立工作階段或更新信任紀錄。
這不會改變舊主機本身使用短碼的限制，也不會替舊主機安裝安全修正。
握手順序依據 [Noise XX 規格](https://noiseprotocol.org/noise.html#interactive-handshake-patterns-fundamental)。

後續協定修改遵循以下規則：

- 應用程式版本、安全握手版本、訊息協定版本分開管理。目前訊息協定的支援範圍
  是 v2；不同應用程式版本使用同一協定時可以互連。不能把未知協定直接當成 v2。
- 功能以加密 Hello 公告的 `terminal`、`file_transfer`、`view_only` 為準，
  不從應用程式版本推測。主機未開放的功能不會因檢視端更新而自動啟用。
- 真正超出訊息協定範圍才拒絕，錯誤訊息會指出需更新的一端。
- Hello 解碼會**略過不認得的尾端位元組**，所以之後的版本可以在後面追加欄位，
  而舊的檢視端照樣讀得到它認得的部分。新欄位只能用追加的方式加，
  不能改動既有欄位的位置或長度。
- `MIN_COMPATIBLE_PROTOCOL_VERSION` 只有在某個版本真的無法再溝通時才調高，
  而且必須寫進發行說明——調高就等於讓那些機器再也連不進來。

中繼站本身不看這個版本：它在 `linked` 之後只盲目轉送密文，所以中繼不需要跟著
兩端一起升級。

相容性回歸測試保留 v0.33.0 的握手做法，驗證舊主機加密 Hello、終端雙向資料、
錯誤配對碼、未知身分、金鑰更換，以及新握手不會降級重試。
這是本機協定測試，不代表每個歷史安裝版本或實際遠端環境都已驗收。
