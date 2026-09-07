# iOS 首次送審補件

2026-09-07 查核 Apple 正式通知：`1.0.0（2）` 於當日 08:16（台灣時間）遭到拒絕，原因是 Guideline 2.1 — Information Needed — New App Submission。Apple 要求了解新開發者帳號提交的產品，未提供特定崩潰紀錄或可重現的程式缺陷。提交 ID 為 `ed1bc1cf-b2e1-410a-9033-9160591d5a81`。

## 實際完成與缺項

| Apple 要求 | 處理狀態 |
| --- | --- |
| 最新系統的實體裝置錄影，從啟動到典型操作 | 待取得；未宣稱已完成實機驗證 |
| 用途、目標使用者、解決的問題與價值 | 已附加至 Apple 審核備註並確認保存 |
| 核心功能操作步驟、登入資料及範例檔 | 原有 SSH／SFTP 私密資料完整保留，已補充其他功能的設定需求 |
| 核心功能使用的外部服務、工具或平台 | 已依送審來源 `60d2bcf` 盤點並保存 |
| 地區間功能差異 | 已說明供應地區功能一致，法國不供應 |
| 受管制業務或受保護第三方內容的文件 | 已說明本 App 的軟體工具用途及示範資料性質 |

Apple 要求資料同時出現在訊息回覆及 App Review Notes。目前已保存文字備註及 Apple 訊息區的回覆草稿，頁面顯示「繼續編輯草稿」，尚未寄出。取得並檢閱錄影後，才補上影片、送出完整訊息並重新提交。沒有重新上傳建置 2，也沒有撤回或移除原提交。

## 不接線的實機準備

使用 App Store 的 TestFlight 在本人 iPhone／iPad 安裝同一個 `1.0.0（2）`。App Store Connect 帳號持有人可使用既有內部測試群組；必須核對測試者實際可存取此建置，不能把「群組存在」當成已安裝。內部 TestFlight 分發與 App Store 審核是不同狀態。[Apple 內部測試說明](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)

本輪查到既有「個人測試」群組含一位內部測試者及 `1.0.0（2）`，群組建置頁顯示「正在測試」。群組內測試者頁曾顯示「沒有可用的建置版本」，進一步查核「所有測試人員」則顯示本人於 2026-09-05「已邀請」、屬於同一群組，尚無安裝或階段作業紀錄。下一步是在手機開啟既有 TestFlight 邀請並確認可安裝建置 2；未重寄邀請、刪除重建群組或建立公開外部測試。

錄影前記錄機型、實際 iOS／iPadOS 版本、App 版本與建置號。Apple 要求最新版作業系統，應在裝置的軟體更新頁查核；不要用建置 SDK 版本代替裝置系統版本。Apple 也要求在支援的實體平台完成品質檢查；未測試的 iPhone／iPad 平台仍須明列。

測試只使用 Apple 審核專用 SSH／SFTP VM 與產生的範例資料，主機、帳密和可信指紋取自本機私密紀錄或 Apple 欄位，不放進公開文件。Mac 需保持開機、連網；若 VM 重啟，示範檔會重建。

## 建議錄影順序

1. 先開啟系統螢幕錄影，再從主畫面點開 LatticeTerm，完整保留首次啟動畫面與載入過程。
2. 新增審核 SSH 連線，填入專用主機、埠號與帳號。登入時先核對可信主機指紋，保留實際確認流程，密碼欄維持遮罩。
3. 在 SSH 終端機執行 `pwd`、`ls -la`、`cat review-data/README.txt`，操作觸控輔助鍵，展示真實回應。
4. 以 SFTP 連接相同主機，進入 `review-data`，下載 `traditional-chinese.txt`，再上傳一個測試文字檔到 `review-data/uploads` 並核對內容。
5. 到 iOS「檔案」的「我的 iPhone／iPad → LatticeTerm」開啟下載內容；回到 App 展示連線設定保存、保管庫或加密備份流程。
6. 展示中斷連線、重新連線，以及前景／背景切換的實際狀態。若發生空白畫面、錯誤或崩潰，保留紀錄並先修正，不剪成看似成功。
7. 若錄製 SSH 通道或 Lattice Remote，使用另外明確授權且相容的測試環境。現有審核 VM 禁止任意 forwarding，也不提供桌面分享；不能為錄影取消隔離限制。

App 沒有 LatticeTerm 註冊、訂閱、付費解鎖或公開社群貼文流程，不製作不存在的畫面。遠端 SSH 登入仍需展示，並說明它是使用者自己的伺服器帳號。

使用系統螢幕錄影即可，影片完成後位於「照片」。錄影無法與系統螢幕鏡像同時進行；不需使用線材。[Apple 螢幕錄影說明](https://support.apple.com/102653)

影片若含審核專用入口，只交付 Apple 私密審核附件或適當限制存取的影片連結，不發布至 GitHub Release、公開網站或 repo。公開商店截圖另外擷取不含私密連線資料的實際功能畫面。

## 英文回覆草稿（尚未送出）

第一項須在實際影片就緒後改填裝置、系統、建置及附件／可存取的連結。下列文字不包含私密入口，送出時引用 Apple 已保存的登入欄位與完整備註。

Thank you for reviewing LatticeTerm 1.0.0 (2). The additional information is below and in App Review Notes.

1. Physical-device recording: pending. No physical-device recording or test is claimed complete. We will provide a recording that begins with app launch and demonstrates the normal workflow before resubmitting.

2. Purpose and audience: LatticeTerm is a general-purpose remote administration client for developers, system administrators and people managing servers they own or are authorized to access. It combines saved connections, an SSH terminal, SFTP file transfers, SSH tunnels and a local encrypted vault on iPhone and iPad. It is not restricted to a particular employer or organization.

3. Setup and access: no LatticeTerm registration, app account, subscription, purchase or paid unlock is required. The sign-in fields in App Review Information contain credentials for the dedicated SSH/SFTP demo server. Use the private host, port and trusted fingerprint in the Notes field, add an SSH connection, and run `pwd`, `ls -la`, and `cat review-data/README.txt`. In SFTP, browse `review-data`, download `traditional-chinese.txt`, and upload a small file into `review-data/uploads`. Downloads are available in Files > On My iPhone/iPad > LatticeTerm. The demo contains generated files only and intentionally disables SSH forwarding. Tunnels require a server that permits the requested forwarding. Optional Lattice Remote requires a compatible companion host and pairing token; relay mode also requires the user's relay address and device ID. There is no public content feed or social publishing service; terminal commands and SFTP transfers target a server chosen by the user.

4. External services, tools and platforms: users choose their SSH/SFTP servers; the review demo runs OpenSSH. Optional Lattice Remote connects to a user-specified companion host or relay, with no preconfigured relay. iOS Keychain and Files provide device storage. GitHub/GitHub Pages host the source code, support and privacy pages. This submitted iOS app has no required hosted login, AI service, payment processor, advertising or analytics service. Desktop AI CLI features and desktop auto-update are excluded from iOS.

5. Regions: features are consistent across all offered regions. The app supports Traditional Chinese and English. France is excluded from distribution. Reachability of a user-operated server depends on that server and network, rather than regional feature gating in the app.

6. Regulated services and third-party material: this app is a software utility, not a financial, medical, gambling or other regulated service. It does not distribute a licensed third-party content catalog. Demo files were created for review; no industry authorization document is applicable.

## 完整補件後的核對

- 檢閱錄影的機型、系統與建置號，確認從啟動到核心功能的操作連續可辨識。
- 重新驗證 Apple 私密入口的外網 SSH／SFTP 可達性，入口變動時先驗收再更新。
- 把實際影片資訊補入 App Review Notes，移除待補文字，重新載入確認保存。
- 在原提交的「回覆 App 審查」送出完整六項回覆與影片，確認訊息確實出現。
- 依 Apple 頁面完成有問題項目的編輯與重新提交，記錄新的狀態；不能把備註已保存當成已重新送審。
- 若實測發現程式問題，另以未使用的建置號製作與驗證修正版，再選取該建置。主分支或 GitHub Release 更新不會替換 Apple 已上傳的 IPA。
