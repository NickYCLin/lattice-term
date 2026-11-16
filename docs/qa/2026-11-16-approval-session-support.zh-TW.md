# 核准卡工作階段範圍對照

以目前桌面的兩個入口、Codex 0.169.0 產生的 app-server JSON schema，及
Claude Code 的官方 PermissionRequest／SDK 契約核對。這張表的「支援」
是目前核准通道能正確送出的決策，不代表每個 CLI 介面都有相同選項。

| 入口／核准類型 | 本工作階段都允許 | 回覆與依據 |
| --- | --- | --- |
| 獨立對話：Codex 指令 | 支援 | 任務 04 的真實 0.169.0 請求與測試；acceptForSession，不套用永久 execpolicy |
| 獨立對話：Codex 檔案變更 | 支援 | FileChangeRequestApprovalResponse：acceptForSession；CLI 定義為同檔案後續變更 |
| 獨立對話：Codex 額外權限 | 支援 | PermissionsRequestApprovalResponse：原請求的 permissions 加 scope: session，不增加其他權限 |
| 獨立對話：Codex 舊版指令／patch | 支援 | ExecCommandApprovalResponse／ApplyPatchApprovalResponse：approved_for_session |
| 獨立對話：Codex MCP 工具 elicitation | 不支援 | McpServerElicitationRequestResponse 的 action 為 accept／decline／cancel；沒有已驗證的 session 決策，不將 persist／always 當作 session |
| 獨立對話：Claude 已驗證的內建工具 | 支援 | claude_session_tool 名單；SDK updatedPermissions 的 addRules，destination: session |
| 獨立對話：Claude MCP 工具 | 支援 | 精確的 mcp__server__tool 規則；不允許萬用字元、不更改其他工具規則 |
| 工作階段對話：Claude PermissionRequest hook | 支援 | hook 決策中的 updatedPermissions，使用同一份工具資格檢查與 session 規則；前景及新版 daemon 通道均可傳遞 |
| 工作階段對話：Codex 終端按鍵核准 | 不支援目前通道 | 只驗證終端實際提供的 y／Esc，沒有可驗證的 session 按鍵；不把永久規則選項改稱 session。原終端仍可操作 |
| 舊版 daemon／未回報能力的工作階段 | 不支援 | 缺少 canAllowSession 預設 false；客戶端在送出 session 回覆前再次核對，不默默降級為一次允許 |
| AskUserQuestion、計畫切換、一般 MCP 表單／URL、未知工具或格式 | 不支援 | 需要個別回答，或沒有已驗證的工具規則；卡片 title 說明原因 |

Claude 的依據：[PermissionRequest 決策與 permission update entries](https://code.claude.com/docs/en/hooks#permissionrequest-decision-control)、
[SDK PermissionUpdate](https://code.claude.com/docs/en/agent-sdk/typescript#permissionupdate)。
官方規則說明：destination: session 只存於記憶體；精確 MCP toolName 規則
不帶 ruleContent。程式不寫入 localSettings／projectSettings／userSettings。
Codex schema 可用 `codex app-server generate-json-schema --out <暫存目錄>`
重新產生；任務 04 的去識別化請求 fixture 保留在 tests/fixtures。

## 統一互動

兩個入口共用 ApprovalActions：允許 → 本工作階段都允許 → 拒絕。
不支援時省略中間按鈕，在卡片及允許按鈕的 title 說明通道限制。
核准卡取得焦點後 Enter 允許一次、Shift+Enter 允許 session；Esc 拒絕。
表單欄位、可編輯區域、組字與其他修飾鍵不觸發卡片快捷鍵；按鈕可用
Tab 取得焦點並照原生按鈕操作。原終端入口保留在這組按鈕之後。

## 生命週期與驗證界線

CLI 自己決定 session 規則的生效範圍；Claude 的 session 規則隨該 CLI
程序結束而消失。Codex 跨輪釋放原生 writer 時，沿用任務 04 的視窗記憶體
暫存，僅比對同一設定及完全相同的指令核准，不擴張到檔案或額外權限。

測試涵蓋前後端能力旗標、Claude SDK／hook 的精確規則與記憶體目的地、
reporter 回覆、daemon wire 的相容性、新舊 Codex 回覆、按鈕順序與
參數、快捷鍵和不支援的 title。未重啟既有 CLI 或 daemon、未更新安裝版，
未透過真實付費模型執行新的 Claude 工具回合。仍需更新後實機確認卡片
排版、鍵盤焦點及各 CLI 實際接受核准後的後續行為。
