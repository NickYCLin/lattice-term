# Apple 審查用 SSH 環境

這份文件與 [sshd 設定範本](review-host/sshd_config.example) 用來準備審查環境。主機位址、密碼、私鑰與實際指紋只保存於私密的作業紀錄及 Apple 審核欄位，不填入本文件。

2026-09-06 使用者指定以自己的 Mac 承載示範服務。已透過 Apple Virtualization Framework 建立獨立 Alpine Linux VM，沒有網路介面、Mac 目錄掛載、SSH agent 或個人帳號。主機僅將專用 TCP 連接埠轉送到 VM 的 virtio-vsock，再進入只監聽 VM loopback 的 OpenSSH。這不會開啟 macOS 的「遠端登入」。

VM 限制為 1 顆虛擬 CPU、768 MiB RAM，SSH 程序另受 128 個程序、256 MiB 記憶體與半顆 CPU 的 cgroup 限制。測試目錄為 128 MiB tmpfs，重啟 VM 後會重建測試資料；審核密碼與主機金鑰則保持不變。審查期間須保持 Mac 開機與網路連線。

本機已通過密碼登入、拒絕錯誤密碼、主機金鑰核對、SSH 指令、PTY／尺寸變更、SFTP 清單、繁體中文下載、上傳內容核對及清理，並確認沒有外連網卡、無法讀取管理員資料及無法使用 SSH forwarding。最終獨立背景服務的[外網驗收](https://github.com/NickYCLin/lattice-term/actions/runs/34018880225)也已通過相同檢查，暫存 GitHub secret 已刪除。這些是主機層的驗收，不代表 iOS 實機互動已通過。

目前使用獨立背景程序與防閒置睡眠機制。LaunchAgent 的啟動未完成，已卸載；不能假設關機重開後自動恢復。重啟及關閉程序依本機私密作業紀錄執行，先核對專用 PID 與程序，不廣泛終止其他服務。正式上架且不再需要此次審核主機後，須撤銷專用連接埠租約並停止 VM。

## 隔離與帳號

使用專供審查、可刪除重建的 Linux VM；不要直接讓審查帳號進入個人 Mac、正式服務或含私人資料的作業系統。個人 Mac 可依上述方式承載無網卡、無主機目錄掛載的獨立 VM。一般 VM 即使 SSH 帳號沒有管理員權限，互動式 shell 仍可以執行程式與發起網路連線。僅關閉 SSH forwarding、使用受限 shell 或 chroot 都不足以作為完整隔離邊界。

部署前須在 VM 外的網路層限制流量，並實際驗證：

- 只開放審查 SSH 連接埠；管理入口另外限制管理者來源，不把管理憑證交付審查帳號。
- 拒絕審查 VM 主動連到外網、區域網路及雲端 metadata 端點；同時涵蓋 IPv4、IPv6 和 DNS。允許已建立連線的回應。套用更新需走獨立維護程序。
- 不掛載正式資料、個人目錄、Docker socket、SSH agent 或雲端身分憑證；VM 不配置可存取其他雲端資源的身分。
- 限制 CPU、記憶體、程序數與測試目錄容量，避免 shell 或上傳耗盡資源。以另一個測試帳號驗證限制，不在審查期間執行破壞性壓力測試。

建立非管理員 `reviewer` 帳號，只放示範資料。密碼使用密碼管理器產生至少 24 字元的獨立隨機值，不使用文件或測試原始碼的範例密碼。若另測試私鑰登入，公鑰由管理者放入範本指定的 root 擁有檔案；私鑰不得進入映像、repo 或公開 artifact。審查完成、取消或疑似外洩時，撤銷帳號與金鑰，刪除測試資料及 VM。

## 套用範本的範圍

範本供已更新的 Linux OpenSSH 使用。它預設只監聽 `127.0.0.1:2222`，允許 `reviewer` 的密碼／公鑰登入、互動式終端機與 SFTP，禁止 root 登入及 SSH forwarding。SFTP 新檔預設採私人權限。`ClientAliveInterval` 用於偵測失聯用戶端，不等於 shell 閒置時限或資源配額。

這是獨立 sshd 的完整設定，不是既有服務的片段；先用 `sshd -t -f <設定檔>` 檢查，再用 `sshd -T -f <設定檔>` 確認有效值，避免其他設定覆蓋限制。它需要事先建立獨立主機金鑰、帳號及相應檔案權限。不要覆寫管理用的 `/etc/ssh/sshd_config`，也不要因此重啟管理連線。

完成 VM 隔離後，再於該 VM 的私密設定副本指定審查介面位址並啟動獨立服務。不能只把 `ListenAddress` 改成公開位址就視為部署完成。從管理介面取得 `ssh-keygen -lf <主機公鑰> -E sha256` 結果，再從外部裝置核對；不能把第一次網路連線收到的指紋直接當成可信來源。

此範本關閉通道功能，因此只能用來示範 SSH 終端機與 SFTP。若審查要測試 SSH 通道，需另外建立只能到指定本機示範服務的目的地規則，不能直接開放任意轉送。

## 示範資料與驗收

帳號家目錄放入 `review-data/README.txt`、包含繁體中文的文字檔與空的 `review-data/uploads/`，內容均為自行建立的測試資料。保留一份非敏感範本供還原，不在審查進行中自動重置連線或檔案。

從實際 iPhone／iPad 逐項記錄結果：

1. 新增 SSH 連線，核對管理介面提供的指紋，再信任主機；錯誤密碼應失敗。
2. 執行 `pwd`、`ls -la`、`printf 'LatticeTerm review\n'`；確認觸控鍵列與終端機輸出。
3. 用 SFTP 開啟 `review-data/`，下載文字檔、上傳新的小檔案，核對內容；測試取消上傳及覆寫提示。
4. 檢查 iOS「檔案」中的下載結果，以及前景／背景、重新連線和保管庫鎖定行為。
5. 確認審查帳號不能存取管理金鑰、取得管理員權限或向禁止的網路目的地連線。不能因 SSH forwarding 已停用便略過 shell 的網路測試。

有效設定檢查、CI 測試、外網可達及實機操作是不同的驗證；尚未完成的項目要保持未完成。通過後再拍攝實際功能截圖，避免在截圖呈現公開主機位址、密碼或私鑰。

## Apple 私密交付清單

在 App Review Information 填入主機、連接埠、使用者名稱、密碼、主機金鑰演算法與 SHA-256 指紋；補充上述終端機及 SFTP 操作步驟、可寫目錄、網路限制及服務維持期間。帳號在審查期間須持續有效，不能加入需要聯絡管理者才能取得的第二階段驗證。這些資料完成前，不宣稱 Apple 已能連入測試環境。

## 從外部網路驗收 Mac 隔離 VM

`iOS review host verification` 是只允許手動啟動的 GitHub Actions 工作，在 Ubuntu runner 執行 `scripts/verify-ios-review-host.py`。它先核對管理端取得的完整主機公鑰，再驗證密碼、終端機、SFTP 與上述隔離限制；不會自動接受未知主機金鑰。

連線設定透過私密的 `IOS_REVIEW_HOST_CHECK` repository secret 提供 JSON，欄位為 `host`、`port`、`username`、`password` 與 OpenSSH 格式的 `host_key`。工作只輸出檢查名稱及通過／失敗，例外僅輸出類型；不輸出主機、帳密或遠端檔案內容。驗收後刪除該 secret，後續需再次驗收時才重新提供。

本機可使用 `--config` 指向已忽略且權限受限的設定檔，並以 `--unix-socket` 驗證 VM 入口。報告會將此結果標為 `unix_socket`，不能當成外網可達；外部 runner 的結果才是 `external_tcp`。兩者一律保留 `ios_device_tested: false`。

參考：[Apple App Review](https://developer.apple.com/app-store/review/)；[OpenSSH sshd_config](https://man.openbsd.org/sshd_config)（包含 shell 存在時，停用 forwarding 的限制）。
