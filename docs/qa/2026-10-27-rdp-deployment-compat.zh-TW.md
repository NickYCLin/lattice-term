# RDP 部署實機相容驗證

## 發現與修正

第一次使用部署檔案通道時，Windows 主機的正常檔案資訊查詢觸發 `received filesystem IRP with trailing RDPDR data`，造成整條 RDP 連線結束。完整錯誤鏈顯示問題在 RDPDR；固定版本的 Query Information decoder 只讀取資訊類別，沒有消耗協定定義的 Length、保留欄位與 QueryBuffer。

另在遠端檔案總管觀察到 `LatticeDeploy` 被截成 `L`，與工具回傳的路徑不符。針對 ASCII 分享名稱改用與 FreeRDP 相同的窄字元 NUL 結尾格式，非 ASCII 名稱保留原有 Unicode 編碼。

使用固定版本的 `vendor/ironrdp-rdpdr` 相容副本，保留 MIT／Apache-2.0 授權，並在 `LATTICETERM_PATCH.md` 記錄原始版本、修正與規格差異。其他 IronRDP crate 仍使用原本固定的 Git revision。RDP engine 也保留完整的斷線錯誤鏈。

## 本機檢查

- RDP engine 格式檢查、`cargo check --locked`、`cargo build --locked` 通過。
- RDP engine 11 項測試通過，包含完整握手後的 ASCII 分享名稱宣告、檔案資訊查詢、非零保留欄位與宣告長度的 QueryBuffer。
- 截斷、宣告長度不足與未宣告的尾隨資料仍會被拒絕；原有唯讀、路徑限制與 JPEG 測試保持通過。

本次只修改 RDP engine 與其相依 crate，未修改桌面前後端；沿用前次已通過的桌面與前端建置。測試版安裝檔重新打包，納入更新後的 engine。

## 安裝版實測

- 已備份並替換本機安裝版的 RDP engine，確認安裝檔案與本次編譯產物的 SHA-256 一致。
- 重新建立受測 Windows 主機的 RDP 連線，確認 `screen`、`input` 與 `upload` 均可用。
- 經逐檔核准，成功備妥 53 位元組的一般文字檔；回傳來源 SHA-256 與 `\\tsclient\LatticeDeploy\rdp-probe.txt`。
- 使用遠端檔案總管開啟回傳的完整路徑，遠端記事本實際讀出預期的測試文字；連線持續超過原先的斷線時間。

本次驗證證明該主機可經 RDP 讀取部署暫存檔案。未替換網站、修改服務或執行正式部署，也未核對複製到遠端目的地後的 SHA-256；不能據此宣稱所有 RDP 主機、非 ASCII 分享名稱或正式部署均已驗收。
