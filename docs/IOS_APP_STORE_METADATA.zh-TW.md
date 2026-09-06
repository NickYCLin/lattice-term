# iOS App Store 資料草稿

本文件保留商店文案與審核備註來源。2026-09-06 已登入 App Store Connect，確認名稱、副標題、繁體中文描述、關鍵字與公開網址已填入草稿；App 仍未送審或上架。先以繁體中文上架內容為主，審核備註另提供英文。實際階段見[發布狀態紀錄](IOS_RELEASE.zh-TW.md#app-store-connect-實際狀態2026-09-06)。

## 可直接使用的文案

| 欄位 | 草稿 |
| --- | --- |
| 名稱 | LatticeTerm |
| 副標題 | SSH 終端機與 SFTP 檔案管理 |
| 主要類別建議 | 開發者工具 |
| 關鍵字 | SSH,SFTP,終端機,遠端連線,伺服器,檔案傳輸,通道,保管庫 |
| Bundle ID | io.github.nickyclin.latticeterm |

### 描述

LatticeTerm 讓你從 iPhone 與 iPad 連接自己的伺服器，使用 SSH 終端機、SFTP 檔案傳輸與 SSH 通道，集中整理日常遠端工作需要的連線設定。

- 依群組、標籤與搜尋管理主機，快速找到需要的連線。
- 使用互動式 SSH 終端機與觸控輔助鍵列，操作 Esc、Tab、方向鍵及 Ctrl。
- 以 SFTP 瀏覽與傳輸檔案，查看傳輸進度。
- 確認 SSH 主機金鑰，透過本機加密保管庫或 iOS Keychain 管理選擇保存的認證資料。
- 支援繁體中文與英文介面。

使用遠端功能需要你有權存取的主機與登入資料。iOS 不執行本機 AI CLI、RDP／VNC 桌面引擎或桌面分享程序。iOS 進入背景後，連線可能被系統暫停或中斷。

### 首版更新說明

首次提供 iOS 版本，包含 SSH、SFTP、連線管理、觸控輔助鍵列及本機保管庫。

## 已備妥網址與尚需資料

| 欄位 | 內容／狀態 |
| --- | --- |
| 版權／銷售者 | 帳號持有人確認的真實姓名或公司名稱 |
| 隱私權網址 | [公開隱私權政策](https://nickyclin.github.io/lattice-term/privacy.html)（2026-09-06 再次確認 HTTP 200） |
| 支援網址 | [公開使用支援](https://nickyclin.github.io/lattice-term/support.html)（2026-09-06 再次確認 HTTP 200） |
| 審核聯絡資訊 | Apple 草稿已有姓名，電話與電子郵件仍空白；只放 App Store Connect，不提交到公開 repo |
| 價格與地區 | 已授權並查核免費、175 個國家或地區；區域合規資料仍須完成 |
| 發布方式 | 已儲存核准後自動發布 |
| 年齡分級 | 已核對 Apple 七步問卷，現有一般分級為 4+；地區分級由 Apple 計算 |
| 加密問卷 | 內建標準加密及法國發行的回答要求法國加密聲明核准書；缺件時不宣稱豁免已核實 |
| 審核示範 | 可公開連線的隔離 SSH 測試主機、受限帳號與驗證步驟；憑證只交付 Apple 審核欄位 |
| 螢幕截圖 | 實際 App 的 iPhone 與 iPad 畫面，依 App Store Connect 當時列出的尺寸匯出 |

截圖建議依序呈現連線清單、SSH 終端機、SFTP 檔案傳輸與保管庫設定。只使用自有測試主機、示範帳號與無敏感內容的資料。模擬器啟動畫面可作為工作證據，但不等於完整商店截圖組。

2026-09-06 已人工檢閱 CI 的 iPhone 6.9 吋（1320 × 2868）與 iPad 13 吋（2064 × 2752）原始 JPEG，確認無 Alpha、呈現真實連線頁且沒有私人主機或認證資料。Apple 允許上傳 1–10 張截圖；現有每種必要尺寸各一張可先作為素材候選，但只呈現空白連線清單，不保證足以說明核心用途或通過審查。上傳前仍須確認與選定建置一致，不製作假的終端機／傳輸成功畫面。[Apple 截圖說明](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots/)

審查主機可依 [隔離環境準備與驗收清單](IOS_REVIEW_HOST.zh-TW.md) 建立；範本預設只監聽本機，不代表已提供可供 Apple 存取的服務。

## App Review Notes（英文草稿）

LatticeTerm is an SSH/SFTP client for connecting to servers controlled by the user. It does not require a LatticeTerm account. Commands entered in the terminal run on the remote SSH server; the iOS app does not download or execute local CLI tools. The iOS package does not contain the desktop RDP/VNC sidecar engines and does not offer local AI CLI sessions.

To review the connection flow, add a connection using the dedicated review server and credentials supplied in the private App Review Information fields, select SSH, verify the host key against the supplied fingerprint, and connect. The same review account can be used for SFTP with a test directory. Local Network access is needed only when connecting to a host on the local network.

Before submitting these notes, the publisher must provision and verify the dedicated review server, supply its expected fingerprint and private credentials, and document the permitted commands and test directory. These details are not included in this public repository.

## 隱私表單盤點

目前 iOS 程式未加入廣告、分析或跨 App 追蹤。連線設定、操作紀錄與保管庫資料在裝置端保存；執行連線／檔案傳輸時，資料會傳往使用者指定的主機或中繼。TestFlight 診斷與使用者主動提交的支援資訊另依 Apple／GitHub 的機制處理。

發行者需以最終 bundle、SDK Privacy Report 與實際提供的服務再次確認 App Privacy 答案。若加入自有雲端或遙測，不能照抄目前的不收集／不追蹤宣告。

2026-09-06 已確認 App Store Connect 的隱私頁已發布「不收集資料」及上述隱私權政策網址。此次原始碼盤點未發現 iOS 廣告或分析服務，行動版也不註冊桌面更新外掛；使用者指定 SSH／SFTP 主機與 App 開發者收集資料需分開判斷。此查核不等於已產生 Xcode Privacy Report，也不包含尚未部署的審核主機或未來代管服務。[Apple 資料收集定義](https://developer.apple.com/app-store/app-privacy-details/)
