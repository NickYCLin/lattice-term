# iOS 發布與驗證

本文件取代早期 Simulator 計畫中的企業 In-House 匯出步驟。Simulator 可啟動、已簽章的實機 App、TestFlight 可安裝與 App Store 已上架是不同狀態，須各自取得證據。

已確認的 CI 基準：`6eb5805` 的 [iOS verification](https://github.com/NickYCLin/lattice-term/actions/runs/33976882169) 已通過 Release 模擬器封裝、無簽章實機封存檔檢查，以及 iPhone 17 Pro、iPhone 17 Pro Max、13 吋 iPad Pro 的 iOS 26.2 啟動畫面驗證；[既有封裝的獨立驗證](https://github.com/NickYCLin/lattice-term/actions/runs/33976882983) 也已通過。實機封存檔的 SDK 為 iOS 26.2，這些結果仍不包含簽章實機安裝或 SSH／SFTP 的 iOS 實際互動測試。

已確認的簽章封裝：`60d2bcf` 的 [iOS signed release](https://github.com/NickYCLin/lattice-term/actions/runs/33969632159) 已產生 `1.0.0（2）` 的 App Store Connect IPA。2026-09-06 取回後，本機重新核對來源 SHA-256、`codesign --verify --deep --strict`、建置號及 iOS 26.2 SDK／隱私宣告皆通過。該 workflow 只完成簽章與匯出，沒有上傳 Apple；後續 Apple 處理與送審證據見下方，TestFlight 實機安裝或升級仍未驗證。

## App Store Connect 實際狀態（2026-09-06）

已使用內建瀏覽器登入 Apple 並查核，不再沿用先前工作階段的「瀏覽器不可用」結論。

| 階段 | Apple 頁面證據 |
| --- | --- |
| 已準備 | 商店名稱、副標題、繁體中文描述、關鍵字、支援與行銷網址、iPhone 6.9 吋與 iPad 13 吋截圖已儲存；隱私頁已發布政策網址及「不收集資料」 |
| 已上傳 | `1.0.0（2）` 的二進位檔狀態為「已驗證」，上傳日期顯示 2026-09-05 21:58；Bundle ID 相符，SDK build 為 `23C57` |
| 已選取建置 | 版本草稿已選取建置 `2`，不得重複上傳同號 IPA |
| 已送審 | 2026-09-06 15:23（台灣時間）正式提交；版本及提交項目均顯示「等待審查」 |
| 已核准 | 尚未 |
| 已上架 | 尚未 |

正式[送審記錄](https://appstoreconnect.apple.com/apps/6808952335/distribution/reviewsubmissions/details/ed1bc1cf-b2e1-410a-9033-9160591d5a81)的提交 ID 為 `ed1bc1cf-b2e1-410a-9033-9160591d5a81`，項目為 `1.0.0（2）`。已依序完成「新增以供審查」及「提交以供審查」，Apple 顯示「已提交 1 個項目」。等待審查不等於已核准或已上架。

價格排程為免費；使用者後續決定先排除法國，已儲存並確認法國為「未供應」，其他 174 個國家或地區保留供應設定。這是發行設定，不代表商店已可下載。免費 App 協議有效，版本發布方式為核准後自動發布。年齡分級七步問卷已核對，現有一般分級為 4+；內容版權缺項已補填並儲存。

審核聯絡姓名、電話及電子郵件已填入 Apple 私密欄位。SSH／SFTP 示範服務依使用者指定由其 Mac 承載獨立 Linux VM；專用帳號、主機、連接埠與可信主機指紋均已交付 Apple，公開 repo 不保存這些資料。英文備註明確說明無需註冊 LatticeTerm 帳號，提供的登入資料屬於遠端示範主機。先前因帳密空白造成的加入審查失敗已解決。

DSA 依使用者確認的個人興趣用途申報非貿易商，Apple 顯示「已完成所有法規要求／通過審查」。這是 DSA 合規結果，不是 App Review 核准。加密問卷仍如實勾選 Apple 作業系統之外的標準加密，並依已儲存的供應設定回答不在法國發行；Apple 判定「無需上傳任何文件」。未捏造法國核准書，也未宣稱 App 不使用加密。既有建置元資料顯示「非豁免類加密：否」，此輪已核對文件要求，但沒有變更已上傳 IPA 的 Info.plist。[Apple 加密文件要求](https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption/)

最終示範服務的[外網驗收](https://github.com/NickYCLin/lattice-term/actions/runs/34018880225)已通過 SSH 密碼／主機金鑰、PTY／尺寸變更、SFTP 上下載及隔離限制；暫存的 GitHub 驗收 secret 已刪除。Mac 上的服務為獨立背景程序，閒置睡眠抑制已啟用；LaunchAgent 未成功啟動，已卸載，不能聲稱重新開機後會自行恢復。審查期間需保持 Mac 開機、連網，詳細邊界見[審核主機紀錄](IOS_REVIEW_HOST.zh-TW.md)。

`d9cf335` 的 [CI](https://github.com/NickYCLin/lattice-term/actions/runs/34010245655)、[iOS verification](https://github.com/NickYCLin/lattice-term/actions/runs/34010245639) 及 [Release workflow](https://github.com/NickYCLin/lattice-term/actions/runs/34010245635) 均已完成且成功。這些新結果不改變前述簽章 IPA 的來源，也不補足尚未完成的 iOS 實機驗證。

## 目前路徑

- Bundle ID：`io.github.nickyclin.latticeterm`。不要沿用舊企業版 `tw.nickyclin.latticeterm`。
- 行銷版本由 `package.json` 與 `src-tauri/tauri.conf.json` 決定；`ios:sync` 同步 XcodeGen／原生 plist。
- 每次送件指定新的建置號，例如同一版本先送 `1`，修正後送 `2`。使用 `bundle.iOS.bundleVersion`，避免把第四段數字附加到版本。
- TestFlight 與 App Store 都用 `app-store-connect` 匯出；`enterprise` 是其他分發管道，`release-testing` 也不作為這裡的 TestFlight 上傳設定。
- `ios:build` 只建立 IPA，不上傳、不加入測試者、不送出審核。

## App Store 優先：不等待接線實測

2026-09-06 的交付方向改為先推進 App Store；不再把接線安裝或 TestFlight 測試完成設為上傳前置條件。尚未執行的真機檢查仍標示未驗證，不將使用者略過測試的決定改寫為通過。Apple 要求提交前檢查完整性與穩定性；本機首次啟動的 WebKit 異常及真機驗證缺口仍是發行風險。[App Review 指引](https://developer.apple.com/app-store/review/guidelines/)

1. 在 App Store Connect 確認既有 App 記錄的 Bundle ID，查明 `1.0.0（2）` 是否已上傳；不要因本機沒有上傳紀錄而重複送同一建置號。
2. 若尚未上傳，使用已驗證的 App Store Connect IPA，透過 Transporter 或已授權的上傳工具交付，等待 Apple 處理完成。上傳既有 IPA 不需要連接 iPhone，也不需要在這台 Mac 重新編譯；本機 Debug Simulator App 不能代替它。[Apple 上傳流程](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
3. 填入[商店資料草稿](IOS_APP_STORE_METADATA.zh-TW.md)、iPhone／iPad 截圖、隱私表單與審核資訊。首發已授權免費、法國以外地區及直接操作發布流程；依實際功能填寫年齡分級與出口申報，不得為了略過問卷而虛填加密或隱私宣告。缺少的身分、聯絡或核准文件不能自行編造。
4. 確認 Apple 可使用審核資料實際操作 SSH／SFTP，選擇已處理完成的正確建置，再執行 Add for Review 與 Submit for Review。兩個動作不同，僅加入草稿不代表已送審。[Apple 送審流程](https://developer.apple.com/help/app-store-connect/manage-submissions-to-app-review/submit-an-app)
5. 記錄送審狀態並處理 Apple 回覆；直到公開商店頁面可取得 App，才標示已上架。若在等待審查時補測，可另用 TestFlight 在手機接受邀請安裝，不需線材；這是可選的補測路徑，不再強制排在上傳前。

帳號登入與雙重驗證由持有人在 Apple 頁面完成；登入後可接續已授權的操作。新法律協議依實際內容及操作介面的要求處理。缺少 Apple 存取時只能完成本機準備，不能宣稱已上傳、已送審或已核准。

## 不需要 Apple 帳號的檢查

```sh
npm ci
npm run ios:check
npm run typecheck
npm run build
npm run ios:prepare -- --build-number 1
```

`ios:prepare` 會更新原生版本鏡像，並將不含帳號資料的合併設定寫入已忽略的 `src-tauri/gen/apple/.release/`。未加入 Apple Developer Program 也可以準備與檢查原始碼。

安裝 Rust iOS target 後，以符合 Mac 架構的目標建置模擬器：

```sh
# Apple silicon
rustup target add aarch64-apple-ios-sim
npm run ios:simulator

# Intel Mac
rustup target add x86_64-apple-ios
npm run ios:simulator
```

`ios:simulator` 自動選擇主機架構，並在暫存目錄建立只供該子程序使用的 Xcode 呼叫入口，明確傳入 Simulator SDK、destination 與單一主機架構；避免 Tauri 2.11.4 封存時誤用實機 SDK，或 Xcode Release 同時連結兩種架構但 Tauri 只產生主機架構的 `libapp.a`。它仍執行 `xcrun --find xcodebuild` 找到的真正 Xcode 工具，不修改 Xcode 安裝或正式實機專案。預設測試建置號為 `1`，可用 `--build-number` 覆寫。

重複建置時，入口會先將同架構的舊 `LatticeTerm.app` 原子搬移到已忽略的 `.release/previous-<架構>-<隨機值>/LatticeTerm.app`，避免 Tauri 因目標目錄非空而在封裝最後一步失敗。舊產物不會刪除；即使本次建置失敗，仍可從輸出的備份路徑取回。產物目錄若是符號連結或一般檔案，會停止並保留原內容。

使用 `npm run ios:simulator:release` 建置經最佳化的模擬器產物，再加上 `--require-declared-api` 執行下述 bundle 檢查，可及早發現 Release 仍保留的未宣告 C API。這個流程仍不需要 Apple 簽章；不能拿模擬器產物上傳商店。

對產生的 `.app` 執行 `python3 scripts/verify-ios-app.py /實際路徑/LatticeTerm.app --check-api-symbols`，檢查 Bundle ID、行銷版本、執行檔、隱私清單、區網說明與桌面 sidecar 邊界，並輸出 C API 匯入盤點。再用 `xcrun simctl install booted /實際路徑/LatticeTerm.app` 與 `xcrun simctl launch booted io.github.nickyclin.latticeterm` 安裝、啟動；產物檢查本身不代表啟動已成功。

`.github/workflows/ios-verify.yml` 會在相關變更推至 `main`、建立 PR 或手動觸發時，使用 macOS runner 上的 Xcode 26 以上版本編譯無簽章的 Release 模擬器 App，再建立實機 archive，分別檢查 bundle。模擬器另以新建的 iPhone／iPad 裝置安裝與啟動，確認程序仍在執行，並以本機 OCR 確認初始連線頁與新增按鈕皆已顯示；保留原始截圖供檢閱，完成後刪除這次測試建立的裝置。這不是完整互動或實機測試。實機產物另檢查 iOS 26 以上 SDK，未宣告的 C API 類別會讓工作失敗。CI 不需要 Apple 密鑰。

本機也可以在建置、bundle 檢查通過後執行相同的畫面驗證：

```sh
python3 scripts/ios-simulator-smoke.py \
  src-tauri/gen/apple/build/x86_64/LatticeTerm.app \
  --local --output output/ios-local-launch
```

Apple silicon 請將上例的 `x86_64` 改成 `arm64-sim`。`--local` 會依 App 的 `MinimumOSVersion` 選用已安裝且相容的最新 iOS runtime，例如 Xcode 16.4 的 iOS 18.6；只建立與清理本次測試的全新 iPhone／iPad，不安裝到或清除既有個人模擬器。截圖與報告留在指定目錄供檢閱。CI 禁止使用 `--local`，仍要求 iOS 26 以上。此入口可驗證開發用 Simulator App，不能作為商店 SDK 或實機安裝的通過證據。

每次驗證請指定新的或空白的 `--output` 目錄。工具會拒絕非空目錄，保留前次截圖及報告，避免把舊的成功紀錄誤認為本次結果。

新裝置首次開機的系統資料移轉在較慢的 Mac 上可能超過三分鐘，可另加 `--boot-timeout 900`。此參數只調整 `bootstatus` 的開機等待，預設仍是 180 秒，允許範圍為 30–1800 秒；App 啟動後的畫面就緒期限仍是 90 秒。不能把系統顯示 `Booted` 或仍在資料移轉中的畫面當成 App 已就緒。

2026-09-06 的 Intel／Xcode 16.4 本機驗證已完成 Debug 封裝及 iPhone 16 Pro（iOS 18.6）安裝。首次啟動空白，系統紀錄顯示 WebKit GPU 子程序無回應後被終止；同一裝置重啟 App 後，連線頁、新增按鈕及導覽列的截圖／OCR 驗證通過。這不等於首次冷啟動或本機 iPad 已通過，亦不取代前述獨立的 iOS 26.2 Release CI 證據。

通過 bundle 檢查後，CI 會保留 `ios-unsigned-release-<commit>` artifact 七天，包含模擬器 App、無簽章實機 archive、兩份 JSON 檢查報告與 `provenance.json`。封裝使用 tar 保留執行權限；provenance 記錄來源 commit、執行編號、模擬器架構及 SHA-256。請先對照來源及雜湊，再將模擬器 App 安裝到相容架構的模擬器。實機 archive 不能直接安裝到手機或上傳商店。iPhone／iPad 的啟動截圖另外存於 `ios-simulator-launch-evidence`，保留十四天；下載到封裝 artifact 不代表後續啟動步驟已成功，仍須確認該次 workflow 結果。

若新建裝置在開機、安裝、啟動或畫面檢查期間失敗，流程會先保存 `*.failure.json` 的失敗階段與原因，再以最多 15 秒嘗試擷取該裝置畫面。即使模擬器無回應而截圖失敗，仍保留原本的失敗結果與紀錄，並清理這次建立的裝置；診斷資料不能當成通過證據。

畫面驗證的總等待上限仍為 90 秒，涵蓋截圖與 OCR。大型 iPad 畫面的單次截圖指令最多等待 60 秒，且不能超過總上限的剩餘時間，避免圖檔已產出卻因指令稍晚結束而提前失敗。仍須辨識完整連線頁及新增按鈕，不能只憑圖檔存在便通過。

[獨立啟動診斷](https://github.com/NickYCLin/lattice-term/actions/runs/33976572887) 的系統日誌顯示，新建 iOS 26.2 模擬器的 `CoreSimulatorBridge` 啟動／開機重試期限為 300 秒，原本外層的 60 秒會提早中止尚未完成的請求。因此啟動指令採 330 秒上限，並記錄實際耗時；上段 90 秒畫面就緒期限從取得 App PID 後起算，仍獨立套用。這些是 CI 模擬器的操作期限，不代表已驗證真機冷啟動效能。

若封裝已完成、僅模擬器階段失敗，可手動執行 `iOS existing bundle verification`，填入原本 `iOS verification` 的工作編號。它只接受同一 repo 主分支的既有工作，核對來源 commit、執行次數、架構及 SHA-256；只要 App 原始碼、依賴或建置設定有變更就拒絕重用。允許差異僅限文件與指定的驗證工具。解壓縮限制路徑、檔案類型、數量及大小，再重新檢查 bundle 並執行完整三種模擬器驗證。這能在沒有編譯工作的環境中重現啟動問題，不會略過失敗或自動重啟 App 來換取通過。新建裝置出錯時另限時擷取與 App 識別碼相關的系統日誌。

本機可執行 `npm run ios:device:unsigned` 建立 `src-tauri/gen/apple/build/lattice-term_iOS.xcarchive`，再對其中 `Products/Applications/LatticeTerm.app` 執行 `--require-store-sdk` 檢查。這是無簽章的實機 Release archive，供提早檢查 SDK 與隱私資源；不能直接安裝到 iPhone 或上傳 App Store Connect。正式發行仍走下面的簽章封裝流程。

### 商店截圖候選素材

CI 加上 `--store-screenshots` 時，保留原本較窄 iPhone 的啟動檢查，另啟動符合 6.9 吋商店尺寸的 Pro Max，並選用 13 吋 iPad。只有主畫面就緒後，才直接由模擬器擷取 JPEG 至 `ios-simulator-launch-evidence/app-store/`；`launch-report.json` 會記錄機型、尺寸、格式及不含 Alpha 的檢查結果。缺少適合機型或尺寸不符會讓工作失敗。

一般 `simctl` PNG 截圖帶有 Alpha 通道，不能直接當成商店素材。這個流程直接擷取原生 JPEG，不縮放、拼接或重畫 App 介面；iPhone 使用 6.9 吋尺寸，iPad 使用 13 吋尺寸。依 [Apple 截圖規格](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)，提供 6.9 吋截圖即可取代 6.5 吋必填尺寸，支援 iPad 的 App 另需 13 吋截圖。

這些素材只呈現初始連線頁，需先人工檢閱才能加入商店草稿；還應補拍 SSH、SFTP 等實際功能畫面。流程不會自動上傳圖片或送審，原始啟動 PNG 仍另外保留為驗證證據。

## iPhone／iPad 的檔案操作

- 連線頁的「匯出」會將連線 JSON 儲存至 App 的 Documents。
- 設定中的加密備份必須完成加密與檔案寫入，才會顯示匯出成功。同名檔案會自動加上編號，不會覆蓋舊備份。
- SFTP 與 Lattice 遠端檔案下載使用同一個 Documents 位置。
- 開啟 iOS「檔案」App →「瀏覽」→「我的 iPhone／iPad」→「LatticeTerm」，即可取得、分享或移動這些檔案。備份若要保留在移除 App 之後，請先移至 iCloud 雲碟或其他位置。
- 連線 JSON 或加密備份的匯入仍由 App 內的檔案選擇器操作。選取 JSON 後會先驗證內容；還原備份需輸入備份密碼並確認。

`UIFileSharingEnabled` 與 `LSSupportsOpeningDocumentsInPlace` 會合併進最終 Info.plist，bundle 檢查會拒絕缺少設定的產物。分享範圍為 Documents；連線資料庫、主機信任與 Vault 仍存於 Library/Application Support，Keychain 也不會因這個設定對外分享。參考 [Apple 檔案分享設定](https://developer.apple.com/documentation/bundleresources/information-property-list/uifilesharingenabled)。

送測前請在實機完成：匯出連線 → 在「檔案」找到 → 再匯入；加密備份 → 移至 iCloud → 還原；SFTP 上傳／下載與重複檔名測試。程式測試與模擬器啟動檢查不代表這些實機互動已驗證。

## 先在自己的 iPhone／iPad 開發測試

`ios:preflight` 與 `ios:build` 檢查的是商店封裝條件；要先測自己的手機，可使用 Tauri 的實機開發流程。先在 Xcode 登入 Apple 帳號並準備開發簽章，連接、解鎖裝置並完成信任配對及開發者模式設定，再執行：

```sh
export APPLE_DEVELOPMENT_TEAM=你的十碼團隊識別碼
npm run tauri -- ios dev --open --host
```

在 Xcode 選擇實際裝置、確認 Signing & Capabilities 的團隊與描述檔，再執行 App。Tauri 指令必須保持執行，因為這個模式的畫面由本機開發伺服器提供；它適合驗證 SSH、SFTP、鍵盤與 Keychain，還不是可離開開發環境使用的正式安裝包。專案的 Vite 已使用 `TAURI_DEV_HOST`；若出現區網權限提示，允許後重新啟動 App。參考 [Tauri 實機開發與 Xcode 流程](https://v2.tauri.app/develop/#using-xcode-or-android-studio)。

帳號登入、雙重驗證與裝置信任由持有人完成；不要把 Team ID、帳號或簽章資料寫回共用專案設定。完成上述實測後，再依下節準備可獨立安裝的簽章封裝。

## 正式封裝

2026-09-05 查核：Apple 自 2026-04-28 起要求 App Store Connect 上傳版本使用 Xcode 26 以上及 iOS 26 SDK 以上。這是建置 SDK 要求，不是把 App 的最低支援系統改成 iOS 26。[官方要求](https://developer.apple.com/news/upcoming-requirements/)

準備條件：

1. 確認已加入有效的 Apple Developer Program，並擁有目標 App／Bundle ID 的權限。免費 Personal Team 只適用開發測試，不能取代商店分發資格。
2. 在 Xcode 登入帳號，確認開發／發行簽章與 provisioning 可用。帳號登入與 2FA 由本人完成，不放進 repository。
3. 在 App Store Connect 建立對應的 iOS App 記錄，Bundle ID 必須相同。
4. 安裝 `aarch64-apple-ios` target，設定實際團隊後執行：

```sh
export APPLE_DEVELOPMENT_TEAM=你的十碼團隊識別碼
npm run ios:preflight
npm run ios:build -- --build-number 1
```

`ios:preflight` 明確列出工具、SDK、Team ID 與本機簽章缺項；它不會查驗付費資格或代替 Apple 的 provisioning 檢查。`ios:build` 發現缺項便在封裝前停止。使用新建置號前，先查看 App Store Connect 已使用的值，避免重複。

用 `python3 scripts/verify-ios-app.py /解開IPA後/Payload/LatticeTerm.app --build-number 1 --require-store-sdk` 檢查正式產物；再由 Xcode Organizer／Transporter 驗證與上傳。Tauri CLI 的封裝方式可參考[官方 App Store 文件](https://v2.tauri.app/distribute/app-store/)。

### GitHub 的正式簽章封裝

`.github/workflows/ios-release.yml` 提供手動觸發的 `iOS signed release` 工作，只接受 `main`，以 Xcode 26 以上版本建置 IPA。它使用 `ios-app-store` environment；設定時將允許的部署分支限制為 `main`，不要將簽章 secrets 放在 PR 工作中。

在該 environment 設定：

- Variable `APPLE_DEVELOPMENT_TEAM`：付費個人或組織團隊的 Team ID。
- Secret `IOS_CERTIFICATE`：含私密金鑰的 Apple Distribution P12，轉成不含換行的 Base64。
- Secret `IOS_CERTIFICATE_PASSWORD`：匯出 P12 時使用的密碼。
- Secret `IOS_MOBILE_PROVISION`：對應同一 Team、Bundle ID 與憑證的 App Store Connect 描述檔，轉成不含換行的 Base64。

憑證、私密金鑰與描述檔只存於受保護的本機目錄或 GitHub 加密 secrets，不能提交 repo。Tauri 會在建置時載入手動簽章資料；前置檢查只確認輸入完整，憑證有效性及配對仍須由實際封装與簽章檢查驗證。[Tauri 簽章設定](https://v2.tauri.app/distribute/sign/ios/)

若使用 Tauri 的 API 自動簽章，前置檢查也接受完整的 `APPLE_API_KEY`、`APPLE_API_ISSUER`、`APPLE_API_KEY_PATH`，會檢查 Key ID、Issuer UUID 與 P-256 私密金鑰格式。這不代表金鑰已獲 Apple 授權；目前的 workflow 使用上面的手動簽章，不需要 API 金鑰來匯出 IPA。

執行工作時填入未使用的建置號。工作會解開匯出的 IPA，檢查 SDK、隱私宣告、簽章、Team、App ID、憑證與描述檔配對、到期日及禁止除錯，再保留 `ios-signed-release-<commit>-<build>` artifact 七天。產物包含 IPA、bundle 報告及 SHA-256／來源 commit；不含 P12 或私密金鑰。這個工作只完成封裝，不上傳 Apple、不寄送 TestFlight 邀請，也不提交 App Review。

## 隱私與加密

- `src-tauri/Info.ios.plist` 是區域網路用途說明的來源，Tauri 建置時會合併進 App。直接手改生成的 plist 不足以保證下次建置保留。
- `PrivacyInfo.xcprivacy` 列出本機檔案中繼資料（容器與使用者選取檔案）、計時／逾時用途；宣告不做追蹤。Xcode 專案的 Resources 階段必須包含它。
- 檔案 API 對應 `backup.rs`、`sftp_transfers.rs` 的 metadata 與安全寫入；計時對應 `tunnel.rs`、`remote.rs` 的 Tokio timeout。最終送件須再檢查 Xcode Privacy Report 與連結進入的 SDK，不能只檢查原始碼。批准理由見 [Apple Required Reason API 文件](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)。
- 2026-09-05 的 x86_64 Debug 模擬器 bundle 含 `fstatfs`、`fstatvfs`、`statvfs` 匯入與 `nix` 檔案系統符號；[Release 模擬器 CI](https://github.com/NickYCLin/lattice-term/actions/runs/33957302485) 的最佳化產物已通過未宣告 API 檢查。實機 Release 仍須單獨驗證，不能直接填入與實際行為不符的 DiskSpace 理由。`--check-api-symbols` 會將未宣告類別列為 `needs_review`；`--require-store-sdk` 會自動盤點並拒絕含未宣告類別的產物。這是保守的 C API 檢查，未涵蓋所有 Objective-C／Swift API，也不取代 Apple 的報告。
- App Store Connect 的 App Privacy 表單與 bundle 的 privacy manifest 是兩份不同資料。依最終產品與第三方服務行為填寫；若之後加入遙測、雲端帳號或代管中繼，需重新盤點。
- App 含 SSH、`ring`、Argon2id 與 XChaCha20-Poly1305；不能因為有 HTTPS 就直接宣告「只用作業系統加密」。此變更刻意沒有填 `ITSAppUsesNonExemptEncryption=false`。由發行者完成 Apple 加密問卷，再依結果補上宣告／文件。[Apple 加密申報說明](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)

## 上架前尚須完成的實測與帳號資料

### OpenSSH 相容性回歸

Linux CI 會安裝 `openssh-sftp-server`，並額外執行：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib openssh_ -- --ignored
```

這 8 項測試直接連接系統 OpenSSH SFTP 子程序的標準輸入／輸出，使用新的臨時目錄與測試資料，不啟動 SSH 服務、不開放連接埠、不需要帳密，也不操作私人主機。macOS 使用系統的 `/usr/libexec/sftp-server`；Linux 使用 `/usr/lib/openssh/sftp-server`。缺少程式會失敗，不能把未執行當成通過。一般 `cargo test` 將它們標示為略過，CI 另行強制執行。

測試涵蓋超過封包大小的大檔往返、上傳暫存與覆蓋權限、取消／未傳完時保留原檔、拒絕覆蓋後來出現的檔案與符號連結、伺服器拒絕權限修改時的清理，以及多批目錄列舉的 10,000 筆上限。測試使用與 App 相同的封包限制及傳輸函式，沒有將測試伺服器或示範帳密加入正式 App。

這只驗證 SFTP 子系統及本機檔案行為，不涵蓋 SSH 握手／登入、同一 SSH 連線的多子通道、網路中斷或 iOS 檔案／Keychain／背景生命週期；下列真機項目仍需完成。子系統參數見 [OpenSSH sftp-server 文件](https://man.openbsd.org/sftp-server)。

### 真機與送審資料

- 用實機驗證首次區域網路允許／拒絕、SSH 密碼與私鑰登入、主機金鑰異動警告、SFTP 上下載／取消、通道關閉、背景／前景切換與 Keychain／保管庫鎖定。
- 用同一 Bundle ID 做覆蓋更新，確認連線設定與保管庫仍可讀；刪除 App 後重裝不能當作資料保留測試。免費簽章與商店簽章的 Keychain 存取仍需實測。
- 依 [送審資料草稿](IOS_APP_STORE_METADATA.zh-TW.md) 補好公開隱私權／支援 URL、真實 iPhone／iPad 截圖、審核連線環境與聯絡人。
- 決定價格、上架地區、年齡分級與出口申報；不替帳號持有人簽署協議。
- 上傳後等待處理，依上方「App Store 優先」路徑完成資料及送審；TestFlight 安裝與升級可另行補測，保留未驗證註記。公開商店頁面可取得 App 前，不要在下載頁宣稱已可從商店安裝。
