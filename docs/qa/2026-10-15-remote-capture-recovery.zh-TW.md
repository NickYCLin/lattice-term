# RDP 中斷後的 Lattice Remote 擷取恢復

## 問題與修正

使用者提供的畫面顯示：Windows RDP 開啟時 Lattice Remote 可串流；中斷
RDP 後，主機仍開機，viewer 卻顯示配對碼遭拒。尚未取得該主機當次的
GDI 錯誤碼，不能把畫面對照當成完整的實機根因重現。

已用真實加密協定重現：正確配對碼握手成功後，只要 Agent 在 Hello 前
結束，原 viewer 也會誤報配對碼錯誤。原 Agent 又把首次桌面擷取放在
Hello 前，後續擷取失敗則會結束整個工作階段。

修正將認證後的工作階段與桌面是否可擷取分離。桌面不可用時傳送既有
JPEG frame 格式的狀態畫面，不新增遠端協定訊息；已授權的其他功能
仍由原 receiver 處理。無有效桌面時禁止輸入、釋放按鍵，恢復後重建
座標映射，丟棄舊世代輸入。暫停時停止擷取，恢復時不重播舊桌面。

OS 擷取使用每個 Agent 程序唯一的 worker，佇列容量為一，單次等待最多
兩秒；桌面不可用時每秒重試，失敗或結果過期會重新列舉 monitor。
這限制卡住的 GDI 呼叫數量，但不聲稱能取消 OS 呼叫：若 OS 永久不
返回，畫面維持不可用，網路取消與非畫面功能仍可運作。

主機狀態新增有時間的分類診斷：waiting、available、noDisplay、timeout、
busy、captureFailed。只接受這些固定值，不記錄密碼、原始 OS 錯誤、
私有路徑或畫面內容。多 viewer 時此欄位代表最近收到的擷取觀察。

![桌面暫時不可用的相容狀態畫面](../../crates/lattice-remote/assets/desktop-unavailable.jpg)

## 本機驗證

- `cargo fmt --all -- --check`：remote crate 與 desktop crate 通過。
- remote crate `cargo check --features agent` 通過。
- remote crate `cargo test --features agent`：106 個 library 測試通過，包含
  錯配對碼拒絕；其他非忽略整合測試通過。既有九個需另開真實主機／
  shell 的情境依原設定忽略，沒有宣稱已跑。
- 最終 Agent 36 項測試通過。新增情境覆蓋有效 JPEG、輸入世代更新、
  卡住擷取的等待與佇列上限、真實認證連線下失敗／恢復／再次失敗／
  再次恢復的 frame 順序、暫停後恢復，以及擷取未完成時取消。
- desktop `cargo check` 通過；`remote::tests` 33 項及 `remote_host::tests`
  10 項通過，包含未收到 Hello 不建立 TOFU pin、正確 Hello 建立 pin、
  錯配對碼仍拒絕、關閉與權限回歸、診斷拒絕任意原始字串。
- desktop 檢查使用 `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`，僅略過
  此獨立工作樹未打包的 sidecar 資源檢查；沒有修改正式設定，也不是
  安裝包驗收。既有 glib lifetime 警告未在本急件修改。
- 狀態畫面已視覺檢查；沒有 React、CSS 或前端邏輯變更。

## 合併前仍須驗證

在隔離 Windows 主機實測正常桌面、RDP 中斷、重新開啟、恢復後鍵鼠、
重複取消與重連。核對 host 診斷分類、frame 更新、既有非畫面功能與
按鍵釋放。Windows 不提供桌面時，不能宣稱可以操控不存在的桌面。

目前可用環境僅 Linux，沒有 Windows 編譯 target；已分享 Windows
MCP target 為離線，唯讀紀錄查詢要求先重連。沒有重啟或切換使用者
工作階段、改分享權限、安裝 service 或用 tscon 強制取得桌面。
Windows 原生建置／實機驗收及已安裝版本驗收均尚未完成。

CI、Windows test installer、iOS verification 維持停用，沒有重新啟用
或手動觸發。PR 應維持 draft，直到上述必要 Windows 驗收完成。
