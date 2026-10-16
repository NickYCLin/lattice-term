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

## 原先的合併前驗證缺口

在隔離 Windows 主機實測正常桌面、RDP 中斷、重新開啟、恢復後鍵鼠、
重複取消與重連。核對 host 診斷分類、frame 更新、既有非畫面功能與
按鍵釋放。Windows 不提供桌面時，不能宣稱可以操控不存在的桌面。

Windows run `38741157865` 已成功，來源為 `f0cec3d`。安裝包與
sidecar 雜湊已核對；既有 24 組篩選共 354 次測試通過、5 次忽略，
MCP 11 項通過。篩選有重疊，不把 354 稱為互不重複案例。
這些結果不等同修正版的真實畫面、鍵鼠或 RDP 驗收。

當時沒有隔離 Windows 測試機或帳號，真實 RDP 斷線／恢復列為環境
缺口，未操作使用者既有工作階段。後續取得建立隔離 VM 與測試帳號
的明確授權，實測結果記於下節；沒有變更宿主機的 RDP 或防火牆。

## 五項擷取恢復的 Windows 增量驗收

既有 Windows workflow 對 Agent binary 只執行 `windows_text_requests`，
因此另補五項恢復測試的 Windows 增量驗收。
沿用 `windows-test-installer.yml` 的 `capture_recovery_only` 選項，
只建置及執行這五項，不重跑安裝包、354 次原生篩選或 11 項 MCP。
一般完整流程亦補入同一 runner，避免日後遺漏。

`verify-remote-capture-recovery.py` 逐項以 `--exact` 執行，強制每項
恰有一項通過且沒有失敗／忽略；保存來源 SHA、run ID、命令、結果
與各自原始日誌。五項皆使用合成畫面、程序內通道或純狀態，認證
fixture 關閉輸入，不開 TCP／relay、不保存配對、不注入 OS 鍵鼠。

本次 runner 的五項 Linux 實跑及零項／忽略／非零退出防護檢查通過，
workflow YAML 與精簡／完整模式互斥檢查通過。

Windows run `38764348535` 已成功，精確來源為
`5190f329b9c91d7f504ba343b2768b66052b942a`；原始 job 日誌逐項核對
五項均通過、零忽略，安裝包工作依精簡模式略過。產物 metadata 與
SHA-256 已從 GitHub 核對。下載連線恢復後，另核對報告中的來源、
run ID、Windows 平台與五份原始日誌，各為一項通過、零失敗及忽略。
工作流已還原停用，沒有為下載失敗重跑 CI。

不以這些程序內測試取代 DXGI 擷取、實際輸入、桌面切換或 RDP 恢復。
此增量驗收當時仍不足以解除 draft，亦未安裝或部署修正版。

## 2026-10-16 隔離 Windows VM 原生驗收

在 Hyper-V 的 Windows 11 Enterprise 評估版客體執行原生 Agent，
以外部 Rust viewer harness 使用正式加密協定連線，另以 RDP ActiveX
控制項建立、斷開及恢復客體的 RDP 工作階段。測試只使用客體專用
帳號、合成文字與測試目錄，未操作使用者的宿主機工作階段。

來源為 `77b1fd94ec2858dc6450e3bfb3e61f5ae3227c9f`。Windows
原生 Agent build、remote crate fmt、`cargo check --features agent`
及 Agent binary 測試均通過；本次 Windows 測試為 32 passed、
0 failed、0 ignored，不與先前其他平台的 36 項混計。

直接複製的 debug Agent 最初因客體缺少 `VCRUNTIME140.dll` 無法
啟動，退出碼為 `0xC0000135`。安裝經 Microsoft 簽章驗證的官方
VC++ x64 執行階段後，安裝與 Agent help 均退出 0，才開始以下驗收。
這是測試 binary 的環境前置條件，不代表已確認安裝包會自帶依賴。

- 第一組在相同 Agent PID、相同 viewer 程序及相同加密連線中完成
  兩次 RDP 斷線／重連。正常桌面為 960×720，失效時改送 960×540
  狀態畫面，恢復後重新收到真實桌面，沒有重新配對或重啟來掩蓋失敗。
- 首輪 frame ID 由正常的 111、失效的 116，接續恢復至 181；第二輪
  由 246、失效的 251，恢復至 256。原生診斷同步記錄
  `available → captureFailed → available`。
- 以 WinForms fixture 的文字與點擊計數檔回讀確認真實 OS 輸入：
  恢復前計數 1，首次恢復後 2，再次恢復後 3；文字分別加入
  `-AFTER` 與 `-SECOND`。不是僅以 input 命令送出當成成功。
- 失效時送入 `MUST-NOT-APPEAR` 與滑鼠點擊，並暫停／恢復串流；
  RDP 恢復後文字沒有該字串，點擊數未增加，沒有重播失效期間輸入。
- 第二組另開 Agent，僅分享合成測試目錄。正常與桌面失效期間均收到
  檔案清單的 `ListStart`、測試檔 `ListEntry`、`ListDone`，確認
  非畫面 receiver 不因擷取失敗停擺，未開放命令執行或其他目錄。
- 在客體以 `GetAsyncKeyState` 定時回讀 Shift：按住時為 True，
  RDP 斷線再恢復後為 False；另一次按住後結束 viewer，亦回到 False。
  沒有補送 key-up 來替代產品的釋放處理。
- 第三組在同一 Agent PID 連續兩次配對與正常取消，兩個 viewer 均
  退出 0，Agent 繼續接受連線。前兩組超過五分鐘後不再接受新配對，
  最後 viewer 離開才退出 0，符合既有配對碼期限，非恢復故障。

失效畫面 SHA-256 為
`2b525262c34fb0b521cb35d0ef96477e6a5c73a76ca338e6d32696deb0375ddc`，
與專案狀態 JPEG 相符；第二輪恢復後畫面為
`dc78baf3a4f0f89f69f1b577c92b30a29a3256ae4cf3725684792f6b4fe04537`。
Agent binary SHA-256 為
`b3f5c2db683838f71acc0cb8b586d30b3317317c5275cb1c62e2188e7e97eaf8`。

以上補齊本 PR 的 Windows 原生畫面、RDP 恢復、鍵鼠與取消驗收。
外部 harness、客體設定、配對碼及原始連線日誌不提交公開專案。
未驗收安裝版 GUI、實體無螢幕主機或 iOS；亦未新增 CI run、安裝包
或 release，手動停用的工作流維持停用。
