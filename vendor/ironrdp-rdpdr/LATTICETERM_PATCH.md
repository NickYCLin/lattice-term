# LatticeTerm RDPDR 相容修正

來源：Devolutions/IronRDP `476b897129634c7f39d5679a80265258d506c1d3` 的 `crates/ironrdp-rdpdr`，保留原 MIT／Apache-2.0 授權。Cargo manifest 改為可獨立解析的固定版本相依，不更動其他 IronRDP crate。

本機修正：

- 依 [MS-RDPEFS 2.2.3.3.8](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpefs/e43dcd68-2980-40a9-9238-344b6cf94946)，完整讀取 Query Information 的 Length、24 位元組保留欄位與宣告長度的 QueryBuffer，避免正常查詢被誤判為尾隨資料。
- 保留截斷與額外尾隨資料的拒絕檢查，不直接忽略所有剩餘資料。
- ASCII 分享名稱採用與 [FreeRDP](https://github.com/FreeRDP/FreeRDP/blob/master/channels/drive/client/drive_main.c) 相同的窄字元 NUL 結尾格式，修正實際 Windows 主機把 UTF-16 的 `LatticeDeploy` 截成 `L` 的相容問題；非 ASCII 名稱保留原本的 Unicode 編碼。這是針對實機互通性的調整，與文件要求 Unicode 的敘述有差異，不能將本項測試描述為所有 RDP 伺服器均已驗證。
- RDP engine 的 `staging` 測試涵蓋實際 RDPDR 握手後的完整 wire request、截斷、宣告長度不符與多餘資料。

只透過 `crates/lattice-rdp/Cargo.toml` 的 Git source patch 使用此副本。上游修正並更新固定版本後，可移除此 patch 與副本。
