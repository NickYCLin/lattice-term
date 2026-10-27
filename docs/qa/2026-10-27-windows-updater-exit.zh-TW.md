# Windows 更新中止與程序退出等待

## 問題與修正

Windows 安裝程式回報 `Failed to kill LatticeTerm`，在複製檔案前中止。
Tauri CLI 2.12.1 的 NSIS 範本使用 Restart Manager 檢查主程式，
關閉程序失敗便中止，沒有先等待更新來源程序自行退出。
上游有相同症狀的退出時序問題回報：
https://github.com/tauri-apps/tauri/issues/16277。
這是與本次症狀相符的原因，未取得失敗當下的 Restart Manager
回傳值，因此不將其視為已證實的唯一根因。

新增 `NSIS_HOOK_PREINSTALL`，僅在 `/UPDATE` 模式下以 Restart
Manager 查詢安裝目錄中的主程式，每次間隔 250 毫秒，最多等待
80 次。每次重設查詢的輸入計數，並保留呼叫端暫存器。
查詢失敗、沒有占用或達到次數上限後，均交回 Tauri 原有的
程序檢查。此等待步驟不終止程序、不略過占用檢查；手動安裝
與解除安裝維持原有行為。等待時間另加 Windows API 呼叫開銷。

## 驗證

執行 `node node_modules/vitest/vitest.mjs run scripts/windows-installer-hooks.test.mjs`。
兩項測試通過，其中一項在 Windows 編譯並執行真正的 NSIS 測試程式：

- 無占用時立即繼續。
- 暫存的 ping 執行檔自行退出時，等待後繼續。
- 持續占用時有界返回，且測試程序仍存活。
- 非更新模式不等待，且所有使用的暫存器保持原值。

測試只操作自己建立的暫存執行檔與結果檔，沒有安裝產品、
終止產品程序或修改登錄。範本先載入 hook、再定義主程式名稱，
測試也採用相同順序。

本機另以 SHA-256 與 GitHub release asset digest 相符的既有
`2026.10.26` 官方安裝檔，在產品程序全部退出後重新安裝：
安裝回傳 0，安裝登錄版本更新為 `2026.10.26`，桌面可開啟。
這確認本機安裝已恢復；既有官方安裝檔不含本次 hook。

## 驗證邊界

本次修改為 NSIS hook 與打包設定，未改前端或 Rust。
已編譯測試安裝程式，未建置完整新版產品安裝包，亦未驗證
不同權限或其他常駐程序造成的關閉失敗。尚未提交、推送、
執行 CI 或發布；新保護需納入後續安裝包才會生效。
