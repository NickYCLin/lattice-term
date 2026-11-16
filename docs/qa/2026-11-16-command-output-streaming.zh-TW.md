# 指令輸出串流延遲定位

## 結果

本次沒有在正式程式找到等待下一筆 delta 的節流，因此保留既有即時
事件路徑，補上後端與實際 React 對話元件的回歸測試。沒有在正式程式
加入時間戳、計時器、flushSync，或把 CLI 未送出的內容偽裝成即時輸出。

目前安裝的 Codex CLI 0.169.0，透過 app-server、隔離 CODEX_HOME 與
本機合成 Responses 服務實測兩次。測試在新的暫存目錄執行每秒印一行、
共五行的 shell 迴圈。使用 exec_command（yield_time_ms: 1000），
再以 write_stdin 等待同一程序；沒有使用真實帳號、付費模型、代理設定
或既有工作階段。時間戳只存在測試程序及暫存目錄。

## 實測證據

去識別化的第一輪觀測保存在
`src-tauri/tests/fixtures/codex-0169-output-streaming.json`。以下 RPC 時間
以測試程序開始為零；shell 時間則以第一行輸出為零，兩者起點不同。

| 觀測點 | 經過時間（ms） | 內容 |
| --- | --- | --- |
| shell 實際印出 | 0、1003、2006、3008、4011 | 每秒各一行，1 至 5 |
| app-server outputDelta | 1219、2222、3224、4227 | 分別為 2、3、4、5，各一筆 |
| CLI 交給模型的第一次工具結果 | 1374 | 1、2，附上仍執行中的 process session ID |
| app-server item/completed | 5229 | aggregatedOutput 完整包含 1 至 5 |
| CLI 交給模型的第二次工具結果 | 5239 | 3、4、5，程序結束 |

第二輪使用可寫原生逐字稿的 thread 再測：delta 在 1244、2247、3250、4252
ms 各送出一行；JSONL 的 function_call_output 確實是先 1、2，再 3、4、5。
因此「工具結果分兩批」已發生在 CLI 產生工具回覆／寫入逐字稿之時，
不是 React 收到每行後刻意等待下一行。原生 outputDelta 是另一條通道，
在本次測試中第 2 至 5 行有逐行事件；第 1 行未送獨立 delta，到最終完整
結果才補齊。不能據此承諾這個 CLI 版本的每一行都有原生 delta。

## 本程式各階段

- stdout：read_bounded_line 在收到完整 JSON 換行後即可返回，不等管線
  關閉、緩衝區填滿或下一筆通知。測試使用保持開啟的 duplex 假 app-server，
  分段寫入 JSON，確認當前事件讀取及解析完成後才寫下一筆。
- 解析／事件：handle_line → codex_notification 每筆產生 ToolOutputDelta，
  正式讀取迴圈隨即呼叫 ChatSink.event；一般工具文字不經圖片儲存流程。
- 前端：事件 listener → applyChatEvent → React。測試掛載實際
  useAgentChat、ChatView 與工具卡，逐筆送 1 至 5 行，每次都在不推進
  fake timer、未送下一筆及未送完成事件前斷言 DOM 已更新。
- 畫面與捲動：同一張卡片與展開狀態保留；原本跟隨底部時隨每筆更新，
  使用者向上捲動後不再拉回。完成事件使用官方完整結果取代串流，不重複累加。

這次前端測試從 Tauri listener 收到事件起驗證 React commit；不把它當成
目前安裝版 WebView、OS 事件傳遞延遲或實際顯示器 paint 的效能量測。

## 其他入口與驗收界線

工作階段對話頁讀取 CLI 的 JSONL snapshot，並非上述 app-server delta
通道；目前另有兩秒 snapshot 輪詢，因此除了 CLI 寫入批次，還可能多等
一次輪詢。這是另一條讀取管線的發現，本次依指定的 outputDelta 範圍
記錄，沒有改動它或從終端重繪文字猜測結構化指令輸出。

安裝版未更新、既有 CLI 未重啟，未重送使用者原本的請求。仍需在更新後
的實際對話入口確認工具卡顯示及體感；無法把本次結果擴張成所有 CLI、
供應商或工作階段逐字稿都已逐行串流。
