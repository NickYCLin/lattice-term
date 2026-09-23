# Herdr 保存與還原設計對照

研究日期：2026-09-23。原始碼固定在 Herdr
[`440a8bdd1e3a809ea76f7cee82d73266d9da54d7`](https://github.com/herdrdev/herdr/tree/440a8bdd1e3a809ea76f7cee82d73266d9da54d7)，
避免把不同版本的行為混在一起。這次閱讀官方文件與原始碼，沒有安裝或執行 Herdr。

## 對重開機遺失問題的結論

Herdr 將「程序繼續執行」和「重建工作環境」分開處理：
關閉介面可以重新接上背景 server；電腦或 server 重啟後，則依保存的資料重建。
它沒有讓原本的程序跨越重開機繼續執行。
參見[官方保存行為說明](https://herdr.dev/docs/session-state/)。

LatticeTerm 原本在 `snapshotLiveWorkspaceSessions` 排除 `detached` CLI，
但專案列表又是從工作階段推導。因此背景程序在重開機後消失時，可能連專案入口一起消失。
另外，`App.tsx` 原本只在沒有桌面擁有的工作階段時還原全部保存項目；
只要已有一個工作階段，就可能略過其餘項目，下一次保存再將它們覆蓋掉。
這是程式碼與回歸案例證實的遺失路徑，尚未藉由使用者電腦的完整重開機驗收。

## 原始碼中值得採用的設計

| 設計 | Herdr 的做法 | LatticeTerm 的適用方式 |
| --- | --- | --- |
| 專案有自己的持久身分 | `WorkspaceSnapshot` 保存 `id`、`identity_cwd`、名稱、tabs；pane 另外保存 cwd 與 agent session | 專案清單應獨立於 CLI 是否存活，避免把程序退出解讀成專案刪除 |
| 畫面與執行狀態分開 | layout snapshot 和選用的 screen history 分開保存 | 舊畫面只能表示歷史，不能當作目前仍在執行或等待核准的證據 |
| 還原失敗仍保留入口 | cold restore 的失敗路徑建立 unavailable terminal，保留 cwd 與版面；另有失敗還原測試 | CLI 不存在、路徑暫時不可用或登入失敗時，仍保留可重試的專案 |
| 原生對話 ID 去重 | resume planner 檢查來源、agent 與 session reference，用 dedupe key 避免重複恢復 | 比對逐一進行，同專案不同 CLI／帳號不能相互抵銷 |
| 不可讀資料先備份 | `SessionWriter` 在覆寫未知／損壞資料前保存原始位元組；備份失敗則停止覆寫 | 解析失敗不等於使用者清空工作區 |

來源：
[snapshot 結構](https://github.com/herdrdev/herdr/blob/440a8bdd1e3a809ea76f7cee82d73266d9da54d7/src/persist/snapshot.rs)、
[還原與失敗測試](https://github.com/herdrdev/herdr/blob/440a8bdd1e3a809ea76f7cee82d73266d9da54d7/src/persist/restore.rs)、
[原生 session planner](https://github.com/herdrdev/herdr/blob/440a8bdd1e3a809ea76f7cee82d73266d9da54d7/src/agent_resume.rs)。

`SessionWriter` 另有兩種不同目的的保留機制：不可讀資料的 recovery copies 保留三份；
健康版面的歷史快照最多 48 份，有 15 分鐘間隔及版面指紋去重。
一般保存先寫暫存檔再 rename，但不能僅憑這點就宣稱每個平台都有完整斷電耐久性；
這段一般保存流程沒有直接呼叫 `sync_all`。
LatticeTerm 若移到原生檔案保存，應沿用既有 `durable_file` 的保護，
另外驗證 Windows 替換、外部修改衝突與寫入失敗。
來源：[writer](https://github.com/herdrdev/herdr/blob/440a8bdd1e3a809ea76f7cee82d73266d9da54d7/src/persist/writer.rs)、
[檔案 I/O](https://github.com/herdrdev/herdr/blob/440a8bdd1e3a809ea76f7cee82d73266d9da54d7/src/persist/io.rs)。

## 對 CLI 狀態與 Jev 的啟發

Herdr 的狀態判斷也有時間上的確認機制。沒有明確 idle 畫面訊號時，
從 working 轉 idle 會先等待重複確認，避免終端短暫沒有輸出就變成已完成；
這份原始碼定義 100 ms 重查、三次確認與 700 ms 上限。
這些值屬於 Herdr 的終端環境，不宜直接當成 LatticeTerm 的通用參數。
來源：[agent detection](https://github.com/herdrdev/herdr/blob/440a8bdd1e3a809ea76f7cee82d73266d9da54d7/src/pane/agent_detection.rs)。

LatticeTerm 應繼續區分 CLI 整合回報、畫面推測與 Jev 建議。
Jev 適合解釋「可能卡在哪裡」，不應決定是否自動送出指令、重啟程序、
刪除專案或改寫已驗證的工作階段狀態。本次第一版維持人工預覽與逐次同意。

## 這次已落實

- 保存背景 CLI 的啟動資訊與背景執行選項，重開機後可以重建。
- 以工作階段、專案、CLI、帳號及原生對話身分逐一比對，僅恢復缺少的項目。
- 保存 runtime ID 供重新接上時辨識；它不會拿來當作 CLI 原生對話 ID。
- 不可讀的 workspace snapshot 在覆寫前保存原文，最多三份；
  保存失敗或偵測到另一個寫入者改動時，不覆寫原始 workspace。
- 補上背景程序全數消失、部分重新接上、多帳號／多分頁、損壞與較新版本資料、
  備份失敗及寫入衝突的回歸測試。

目前仍用既有 WebView localStorage，尚未建立 Herdr 那種 server-owned 完整專案資料庫。
後續已新增獨立的 `latticeterm.localProjects.v1` 專案清單：
啟動時從既有工作區與本機 CLI 移轉，關閉 CLI 不會刪除專案；
「已存專案與復原」提供明確移除入口，且不操作磁碟上的資料夾。
recovery 資料位於本機 `latticeterm.workspaceSessions.recovery.v1`，
可能含本機路徑與啟動設定，不應貼到公開 issue。
現在會保留最近三份不同的非空工作區或不可讀資料，提供備份預覽及匯入；
匯入只合併缺少的本機工作階段，逐項按下重試才啟動 CLI。
無法解析的備份只顯示不可讀，不執行、不丟棄原文。
先前已被舊版覆蓋、又沒有備份的內容，也不能由這次修正憑空還原。

## 後續優先順序

1. **原生端單一寫入者**：保存專案、session intent 與還原結果，
   前端只顯示狀態，減少多視窗及關機時的保存競爭。
2. **故障驗收矩陣**：實際測試正常關閉、強制終止、電腦重開機、
   CLI 更新、磁碟暫時不可用、資料損壞，以及多帳號的原生對話還原。

以上是後續設計安排，並非本次已完成的功能。
