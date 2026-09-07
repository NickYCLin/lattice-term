# iPhone 介面修正與驗證

2026-09-07 使用者在 TestFlight `1.0.0（2）` 回報終端機太窄，無法正常輸入 `ls -la`。此問題獨立於 Apple 的 Guideline 2.1 補件要求，須先提供修正版，再錄製實機操作影片。

## 原因與修正

SSH 工作階段原本會自動打開 SFTP，檔案面板至少占用 `17rem`，手機也沿用左右並排。用真實前端元件在 393 × 852 的 iPhone 尺寸重現：檔案面板 272px、終端機只剩 59px，約能顯示三個字元。

- 手機預設只顯示終端機，使用「終端機／檔案」按鈕切換完整寬度；切換時保留 SSH 與終端輸出，不重新連線。桌面仍保留自動開啟檔案的並排方式。
- 工作階段隱藏重複的全域頁首，減少四周留白；393px 螢幕的終端機寬度增為 371px，測得 46 欄。
- 輔助列提供鍵盤開關與 Enter，觸控按鍵至少 44px；較多輔助鍵可在列內橫向捲動。表單文字輸入使用 16px 字型。
- 行動版外框與彈窗跟隨 `VisualViewport` 高度與位移；軟體鍵盤出現時收起底部導覽。捏合縮放不強迫重新排版，鍵盤收起與旋轉後重新量測。軟體鍵盤可能只改變可視視窗，原本的 `100vh` 無法涵蓋此情況。[MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)
- 修正小螢幕通道篩選列、通道表單、連線抽屜與配對彈窗；通道彈窗加入關閉標籤與鍵盤焦點管理。
- 保管庫在手機改為直向資料卡，完整保留主機、指紋、時間和操作；SFTP 放大操作按鍵並讓檔名取得較多寬度。
- 底部導覽增加文字。手機活動頁只顯示連線操作紀錄，設定正確標示 iPhone／iPad App，移除要拿另一支手機掃描的安裝區塊。

## 驗證邊界

本機使用真實 App、xterm 與前端元件，透過 Tauri 的 `mockIPC` 提供不含機密的展示資料。這能驗證版面、事件與前端操作，**不代表真正的 SSH／SFTP 伺服器、Keychain、檔案寫入或實機功能通過**。測試工具及原始紀錄在未提交的 `output/ios-layout-review/`。

| 檢查 | 結果 |
| --- | --- |
| 393 × 852 終端機 | 從 59px 擴大至 371px；輸入 `ls -la` 並由 Enter 送至測試 IPC 成功 |
| 320 × 568、393 × 480、852 × 393、1024 × 1366 | 我的連線、工作階段、通道、保管庫、活動、設定共 24 組版面檢查；控制項無頁面水平溢出，輔助鍵列採預期的內部水平捲動 |
| 新增連線 | 320px 表單可捲動，底部儲存可點擊，新增展示連線成功 |
| 通道、遠端配對彈窗 | 小螢幕欄位不橫向溢出，內容可捲動 |
| 保管庫 | 320px 時資料卡寬 272px，指紋與操作不需橫向尋找 |
| 單元測試 | 新增可視視窗變更、縮放、旋轉、事件合併與清理測試；交付 commit 的 CI 完整前端測試為 102 個檔案、651 項通過 |
| 型別與正式前端封裝 | 本機及 CI 通過；本機缺少 npm 執行檔，使用 Node 直接執行同一份 TypeScript、Vitest、Vite CLI。前端入口 329.75 KiB，低於 500 KiB 限制 |
| 一般 CI | Rust 格式、測試及 lint 通過；真實 OpenSSH subsystem 的 8 項 SFTP 整合測試通過，與前端展示資料測試分開計算 |
| iOS Release CI | 模擬器 App、實機 archive、SDK 與隱私內容檢查已通過；本次 iPhone／iPad 啟動檢查仍在執行，尚未列為通過。[工作紀錄](https://github.com/NickYCLin/lattice-term/actions/runs/34129765046) |
| iOS 軟體鍵盤 | 獨立 WebKit／XCUITest 在本機 iOS 18.6 模擬器啟動期間逾時，未完成鍵盤輸入斷言；當時系統負載很高，已停止該次模擬器。這不是已通過的實機或 Release 驗證 |
| 使用者 iPhone 上的修正版 | 尚未安裝；目前手機仍為已上傳的 `1.0.0（2）` |

## 交付進度

修正已推送至 `b24dce1de2eeba864a358b919d4c218a649c8251`。[一般 CI](https://github.com/NickYCLin/lattice-term/actions/runs/34129764944) 已通過；[簽章工作](https://github.com/NickYCLin/lattice-term/actions/runs/34129922242) 已產出 `2.0.0（3）`，版本沿用目前主線的 `2.0.0`。建置前已查 App Store Connect，尚無此版本或建置號，未重複上傳 `1.0.0（2）`。

新 IPA 已下載至未提交的 `output/ios-signed-build-3/`，並重新通過 SHA-256、來源 commit、App Store 描述檔、簽章／憑證配對、禁止除錯、iOS 26.2 SDK 與隱私 C API 匯入類別檢查。這些檢查不替代 Xcode Privacy Report 或實際用途審查。IPA SHA-256：`7f81ce30e4b56dfc03ec749ebb095d0f66aebf7719087b3ac1ac099a54172102`。

目前狀態是 **IPA 已準備，尚未上傳 Apple、尚未提供新版 TestFlight、尚未重新送審**。上傳需要 Apple 帳號授權，App Store Connect 的網頁登入與二進位上傳授權分開處理。使用者 iPhone 16 的 TestFlight 裝置資訊顯示 iOS 26.6.1；新版尚未安裝到該裝置，實機軟體鍵盤及審核影片仍待完成。
