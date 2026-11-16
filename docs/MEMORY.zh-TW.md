# 跨工具專案記憶庫

LatticeTerm 管理經使用者確認的中立記憶，再輸出成 CLI 能讀的專案指示。
它與既有「共用 AI 規則」分開，不代替各 CLI 的原生自動記憶，也不自動學習
所有訊息。記憶只供背景參考，當下的明確要求仍優先。

## 使用方式

對話設定 → 指示與記憶 → **跨工具記憶庫** 可新增、編輯、釘選、刪除，
並查看來源、建立／最後使用時間、輸出大小與 CLI 同步狀態。
使用者及助理文字訊息的 **存為記憶** 會先開編輯框，可刪去不適合長期保存的
內容，選擇此專案或跨專案後才儲存。一般對話、PTY 訊息及唯讀原生紀錄均有此動作。
純圖片／工具事件不提供這個文字動作。

匯入時先選來源、讀取候選，逐條勾選並確認；沒有預先勾選。取消不寫入。
原生自動記憶不會改寫、搬移或刪除。專案指示檔只同步自己的受管理區塊，
原有記憶段落不變。內容只做確定性的分段與去重，不用模型推測決策。
含疑似機密者先遮罩並禁止匯入；若要保留非敏感部分，請另外手動建立精簡條目。

## 中立格式與位置

預設每個專案使用 `.lattice/memory/entries.json`，UTF-8 JSON，`version: 1`：

```json
{
  "version": 1,
  "entries": [
    {
      "id": "0123456789abcdef0123456789abcdef",
      "kind": "project",
      "content": "資料匯入測試使用合成 fixture。",
      "source": {
        "kind": "conversation",
        "cli": "codex",
        "conversationId": "synthetic-conversation",
        "path": null
      },
      "createdAt": 1,
      "updatedAt": 1,
      "lastUsedAt": 0,
      "pinned": false,
      "archived": false
    }
  ]
}
```

- `kind` 為 `user`、`feedback`、`project`、`reference`；**類型與儲存範圍獨立**。
- `archived` 預設 false；封存後不再全文輸出給 CLI，但完整內容仍在中立 store，可查看或編輯重新啟用。
  Task 35 開始寫入此欄位，舊版讀取器會拒絕未知欄位；請使用支援此格式的 App，
  不要用舊版寫回同一份記憶庫。
- `source.kind` 為 `manual`、`cli`、`conversation`；來源可帶 CLI、對話 ID 或原始檔路徑。
- 時間為 Unix 毫秒，`lastUsedAt: 0` 表示尚未由啟動同步使用。
- 每個 store 最多 256 條，單條內容 8192 bytes，整份 JSON 最多 1 MiB。
- 專案身分是選定工作資料夾的 canonical 絕對路徑。相同 symlink 目的地共用；
  不自動合併不同 Git worktree、父子資料夾或名稱相同的資料夾。
- 可改存 App 資料目錄的 `project-memory/projects/<canonical 路徑雜湊>/entries.json`；
  同目錄 `settings.json` 記錄選擇。切換會複製，不刪舊檔；目的位置有不同記憶則拒絕覆蓋。
- 跨專案 store 為 App 資料目錄 `project-memory/user/entries.json`，不寫入各 CLI
  的使用者目錄。之後在任何專案啟動支援的 CLI 時會與該專案條目合併輸出。

App 儲存模式只改 JSON 位置，**專案的 AGENTS.md 等輸出仍含記憶文字**。
使用者決定是否納入版控。介面提供明確確認後才在 `.gitignore` 附加
`/.lattice/memory/`；不更動既有行、不取消追蹤、不忽略 AGENTS.md 等指示檔。
不會未經確認自動修改 `.gitignore`。

## 對映與同步

AGENTS.md 使用獨立的標記：

```markdown
<!-- LatticeTerm project memory: start -->
…由中立條目產生的 Markdown…
<!-- LatticeTerm project memory: end -->
```

與 `LatticeTerm shared AI rules` 標記不同。更新只替換自己的區塊；沒有區塊時
在檔案末尾附加，保留原文字及換行風格。重複同步不產生重複區塊。
釘選優先、建立時間及 ID 決定穩定順序；先跨專案，再此專案。
最後一條刪除後移除自己的內容區塊，不刪除原有指示檔。

| CLI | 取得方式 | 額外檢查 |
| --- | --- | --- |
| Codex | AGENTS.md | 非空 AGENTS.override.md 會遮蔽，標示人工檢查並阻止本次帶記憶啟動 |
| Claude Code | CLAUDE.md 匯入 `@AGENTS.md` | 已有有效匯入不重複新增；新匯入放自己的區塊 |
| Gemini CLI | GEMINI.md 匯入 `@./AGENTS.md` | 自訂 context 檔名／停用指示須自行核對 |
| Qwen Code | QWEN.md 匯入 `@./AGENTS.md`，也支援 AGENTS.md | 自訂檔名／停用指示須自行核對 |
| GitHub Copilot CLI | AGENTS.md | 原生信任／設定仍由 CLI 決定 |
| OpenCode | AGENTS.md | 原生規則停用設定仍由 CLI 決定 |
| Kimi CLI | AGENTS.md | 原生信任／設定仍由 CLI 決定 |
| Grok | 保留 AGENTS.md 輸出，固定標示人工檢查 | xAI Grok Build 與其他同名 CLI 不是相同實作，不宣稱已由 CLI 載入 |

狀態「已同步」只表示受管理檔案與預期輸出一致，不代表 CLI 已讀入、帳號已登入，
或模型一定遵循。其他自訂指示名稱、CLI trust 及管理員設定不在此介面自動修改。
既有 CLAUDE.md／GEMINI.md 透過共用規則區塊匯入 AGENTS.md 時保持原樣。

儲存後嘗試同步；LatticeTerm 的 PTY 啟動／恢復及 app-server 送出路徑也會在
啟動前同步。跨專案條目有變動時，其他專案在下一次啟動時更新，並非掃描所有磁碟。
已執行中的 CLI 不一定重新載入指示；需要時使用原生重新載入指令或重開對話。
最後使用時間表示 LatticeTerm 同步後準備啟動該 CLI，不代表模型實際引用了條目。

記憶輸出預設門檻為 **12 KiB**，可在「設定 → 對話 → 記憶與交接壓縮」調整。
實際輸出取設定值、16 KiB 安全上限及 AGENTS.md 的剩餘空間之最小值，
並套用保守的 200 行限制。AGENTS.md 整份仍不超過共用規則的 **32 KiB**。
未釘選內容會自動精簡／封存；釘選內容或最小索引仍超限時保留正本、顯示需同步，
阻止帶著過期輸出的新啟動，不改寫管理區塊外的規則。缺失／重複標記、標記落在程式碼圍欄、symlink 或
無法安全處理的檔案會標示人工檢查，不覆蓋外部內容。

## 唯讀匯入規則

只讀固定 Markdown 名稱／記憶子目錄，不跟隨內容中的連結或 `@` 匯入：

| 來源 | 讀取範圍 |
| --- | --- |
| 所選專案 | AGENTS.md、CLAUDE.md、QWEN.md；排除 LatticeTerm 已管理的區塊 |
| Claude | 帳號設定目錄或 CLAUDE_CONFIG_DIR／`~/.claude` 下 `projects/<專案 slug>/memory/*.md`，包含 MEMORY.md 索引與主題檔 |
| Codex | 帳號設定目錄或 CODEX_HOME／`~/.codex` 下 `memories/*.md`、`memories_v2/*.md` 及各自 `rollout_summaries/*.md`；不修改產生狀態、不解析其他儲存格式 |
| Gemini | 專案及帳號目錄／`~/.gemini` 的 GEMINI.md 中 `## Gemini Added Memories`，直到下一個同級標題 |
| Qwen | 帳號設定目錄或 QWEN_HOME／`~/.qwen` 的 QWEN.md |

目前使用中的帳號設定目錄只交給同一個 CLI 類型；切換其他來源使用其預設目錄。
Claude slug 與既有指示檢視相同，把專案 canonical 路徑的非 ASCII 英數轉為 `-`。
自訂 Claude autoMemoryDirectory 或不同版本的記憶標題不猜測、不擴大掃描；可手動複製
非敏感內容建立記憶。Codex 原始 memories 的內容仍由 Codex 自己維護。

以 Markdown 一／二級標題分段，支援 Claude frontmatter 的四種類型；空白正規化＋
小寫比較去重，與已有 user/project 條目及同一批候選比對。先顯示候選，確認時重算
來源指紋；來源或目的檔案變更便拒絕，需重新預覽。上限為每個來源目錄 64 個檔案、
總計 128 個檔案、每份 64 KiB、256 個候選；過大、不安全或無法解析者略過並提示。

## 安全界線

- 所有進入畫面的記憶內容與來源先走與原生逐字稿相同的機密遮罩。
  手動、訊息或匯入保存時，只要疑似機密或包含 `[REDACTED]` 就拒絕，
  不把遮罩後的半份機密當成可用記憶。
- 涵蓋 OpenAI／Anthropic／Google／GitHub／AWS／Slack 常見金鑰、
  Authorization／Bearer、PEM 私鑰、URL 帳密及 password/token 等鍵值。
  這是啟發式偵測，使用者仍應檢查商業敏感資訊；不保存密碼保管庫資料。
- 不開啟 auth.json、credentials、.env、keychain、token 快取，
  不讀原生 SQLite 狀態或跟隨 Markdown 指向的檔案。
- 拒絕 `..`、非絕對根路徑、記憶路徑中的 symlink／Windows reparse point、
  特殊檔案。App 資料目錄以排他檔案鎖協調程序；視窗修訂指紋避免覆蓋外部更新。
- 暫存檔同目錄、同步寫入、保留既有權限後替換；多檔更新有前置檢查與可還原備份。
  發生外部衝突時不強行蓋回；罕見回復衝突可能留下 `.lattice-memory-*.bak` 供人工救回。
- 原生指示檢視也以有界 no-follow 讀取並遮罩；含機密的使用者指示不開放直接編輯，
  避免用已遮罩的畫面覆寫原始檔。

## 官方依據與驗證界線

以下為 2026-11-17 核對的官方文件／原始碼；不是宣稱每種已安裝版本都實測：

- [Claude Code memory](https://code.claude.com/docs/en/memory)：指示匯入與自動記憶分離。
- [Codex memories 原始碼說明](https://github.com/openai/codex/blob/main/codex-rs/memories/README.md)：記憶屬 Codex 管理狀態。
- [Gemini GEMINI.md](https://geminicli.com/docs/cli/gemini-md/) 與 [memoryTool](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/memoryTool.ts)：匯入與記憶段落。
- [Qwen memory](https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/)：QWEN.md／AGENTS.md／匯入。
- [Copilot 自訂指示](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)。
- [OpenCode rules](https://opencode.ai/docs/instructions)。
- [Kimi agents](https://moonshotai.github.io/kimi-code/en/customization/agents)。
- [xAI Grok Build project rules](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/12-project-rules.md)：依實作與信任設定載入。

本次自動化使用合成檔案與臨時目錄，未讀取或修改個人 CLI 記憶。
真實帳號、已安裝 App 畫面與各 CLI 是否實際重新載入，仍需安裝後個別確認。
測試紀錄見 [任務 34 QA](qa/2026-11-17-cross-cli-memory.zh-TW.md)。

## 自動壓縮與可還原版本（任務 35）

設定存在 App 資料目錄 `project-memory/compaction.json`，桌面與背景服務共用，
不是各視窗各自的暫存偏好。預設門檻 12288 UTF-8 bytes、保留最近 20 份、
過時判斷 90 天、AI 關閉。可調整為 2048–16384 bytes、2–100 份、1–3650 天。
這是 bytes／行數上限，不宣稱精確 token 數。Claude 的 MEMORY.md 索引有
200 行／25 KB 載入限制；本功能寫的是 AGENTS.md 匯入區塊，並非原生 MEMORY.md，
但共用輸出仍採更保守的 16 KiB／200 行界線。CRLF 會按實際輸出 bytes 計算。
管理介面顯示的上限也會扣除既有 AGENTS.md 規則佔用，原規則不參與自動摘要。

新增、匯入、按「立即精簡」及支援 CLI 啟動前都檢查。還原本身先保存目前版本，
恢復所選範圍後先讓使用者檢查；下一次新增／匯入／啟動再檢查門檻，避免還原後
立即變回剛才的結果。超限釘選條目會保留並提示，使用者可自己編輯或刪除。

確定性策略：

1. 同主題的「標題：內容」輸出為一個標題下的清單；不改變正本條目的內容。
2. 完全重複及僅有空白、大小寫或句末標點差異者，保留優先度較高的一條輸出，
   其他條目標為封存。路徑大小寫、數字、內部標點、命令旗標與否定詞保留，
   不用語意相似度猜測不同決策是否相同。不同 scope 不合併。
3. 過時且未釘選的 project/reference/user 條目先封存；feedback 優先保留。
   最後使用時間沿用「準備啟動 CLI」的時間，不宣稱模型實際引用。
4. 若仍超限且 AI 已啟用，嘗試一次摘要；失敗恢復確定性階段的狀態，不自動重試。
5. 仍超限時依未釘選、非 feedback、較舊的順序封存，直到可容納。
   釘選條目絕不因自動壓縮被刪除或封存。封存索引每個 scope 顯示最多四個短標題，
   其餘數量指向記憶庫；介面仍可查看所有完整條目。

「封存」是 `archived: true`，不是刪除內容，原有 256 條／1 MiB store 安全上限仍在。
因此大量封存不等於無限儲存空間；碰到 store 容量上限會明確拒絕新寫入。

壓縮開始前會先落盤完整 scope 快照；成功後記錄該範圍輸出前後的 Markdown。
user 快照只含 user，project 快照只含 project，不把專案資料提升成跨專案內容：

- 專案位置：`.lattice/memory/archive/<毫秒>-auto-<隨機 ID>.json`。
- App 專案位置：`project-memory/projects/<canonical 路徑雜湊>/archive/`。
- 跨專案：`project-memory/user/archive/`。
- 還原前快照使用相同格式、檔名的 `restore` 標記；每個 scope 保留最近 N 份。
  在專案與 App 儲存間切換，兩個已知位置的舊版本仍可讀，保留數共同計算。
- 每份含版本、時間、原因、完整 before store、beforeText／afterText 與警告。
  中途失敗可能只有 before；介面標示未完成，原文仍可還原。

「已自動壓縮」紀錄可展開前後差異並一鍵還原；記憶管理區也持續列出版本。
App 內新增／匯入後會顯示紀錄，背景程序壓縮則可於下次重新載入記憶庫查看。
還原不會改寫原 CLI 的 MEMORY.md、Codex memories 或 Gemini 記憶段落。
只有符合本程式檔名、位置及一般檔案檢查的快照會被清理；不掃描刪除原生紀錄。
既有 `.gitignore` 選項涵蓋 archive，不會為此自動修改 .gitignore。

### 選用 CLI 摘要

目前提供 **Claude Code 的既有登入帳號**，可選預設或 LatticeTerm 已設定的 Claude
帳號目錄。儲存啟用設定時以 CLI 的 `auth status --json` 確認登入，App 不開啟認證檔。
未安裝或未登入便不啟用。沒有為其他 CLI 猜測尚未驗證的非互動工具限制。

已在本機 Claude Code **2.1.325** 的 `--help` 核對 `-p`、`--tools ""`、
`--strict-mcp-config`、`--setting-sources`、`--settings`、`--json-schema`、
`--no-session-persistence` 與 `--max-turns`；參考
[官方非互動說明](https://code.claude.com/docs/en/headless)。
沒有使用 `--bare`，因為該模式不使用訂閱 OAuth 登入。

實作在空白臨時資料夾執行，停用內建工具、MCP、一般 hooks 與 auto memory，仍尊重 CLI 的強制管理政策，
不保存原生對話；scope 分開摘要，不把專案記憶變成全域偏好。提示要求保留關鍵
事實、決策、偏好、否定限制、路徑與數字，並禁止新增事實。輸出必須是有效 JSON、
較短、在長度限制內、未含機密，且原有數字與路徑仍存在；否則退回。
這些檢查不等於能證明所有語意完全一致，完整原文與版本因此始終保留。

記憶的每個 scope、每份交接候選最多一次摘要呼叫；逾時 45 秒、登入檢查 8 秒，輸出最多 64 KiB。
Unix 使用程序群組、Windows 使用 Job Object 收束子程序。真實摘要可能使用訂閱
或已配置服務的額度；自動化測試只用替身腳本，沒有呼叫真實 AI 服務。

## 結構化交接與歷史背景

新的交接檔／實際送出的跨 CLI 參考改用固定欄位：目標、已做決策、已修改檔案、
未完成事項、最後數輪原文、工具摘要與結束狀態、原始完整紀錄參照。
欄位是確定性摘錄，沒有明確紀錄就標示未確認，不把「提過檔名」當成已完成變更。
工具大量輸出不重複塞入提示；只留名稱與可辨識的退出碼／完成或未知狀態。
近期訊息過長時節錄並標示，完整的遮罩後輸入先保存為 App 擁有的 JSON。

原始輸入／來源參照與報告存於 `project-memory/handoffs/archive/`，保留最近 N 份。
「設定 → 對話 → 記憶與交接壓縮 → 交接與背景摘要紀錄」可查看，對話頁亦顯示
可展開的自動壓縮紀錄與原文／摘要比較。即使短內容不需縮短，也會結構化並留來源。
既有短期 handoff Markdown 仍會於 24 小時後清理；原始 JSON 依 N 份策略保留。

撰寫列的歷史附件圖示可從已支援的歷史清單選 **1–5 段**，按「產生摘要預覽」後
才決定附加並開新對話；取消不建立新對話，也不會自動送出。預覽會產生本機摘要
與原文紀錄，取消不刪這份可回查資料。新對話保留目前選用的 CLI、帳號、服務與
資料夾，不借用任何來源的 native session ID。多段來源的目標與近期訊息分開標記，
不讓最後一段蓋掉前面的背景；同樣受一份總門檻限制。

原生歷史沿用既有的近期快照安全上限，摘要不宣稱已閱讀整份超大歷史；完整原生
紀錄以經身分檢查的路徑引用，仍由原 CLI 管理。來源身分是 CLI＋帳號＋native ID，
不以標題合併、不猜另一個帳號。App 內換 CLI 仍保留原 thread 的全部可讀項目，
發送時使用這份來源建立遮罩原文，避免只保留舊的 48 KiB 尾端。
每次背景輸入有 2000 項／3 MiB 邊界，快照檔最多 4 MiB；超過安全邊界明確拒絕，
不假裝已讀取或保存全部內容。太小的門檻會讓多來源摘錄更短，仍可由封存參照查原文。

所有內容在寫入封存、提示或回到畫面前走同一機密遮罩，遮罩內容不可還原。
一般敏感業務資訊仍需使用者判斷；本程式不把原生 auth.json、credentials、.env、
keychain 或 token 快取當成背景來源。原生 CLI 紀錄不改寫、不搬移、不刪除。

交接先去除大型工具輸出並組成確定性候選；若候選仍超過門檻且 AI 已啟用，
在原文落盤後嘗試一次同一摘要 CLI。提示要求保留所有欄位標題、來源標記、
數字、路徑與原始紀錄參照；不合規便退回已受門檻限制的確定性摘錄，並顯示警告。
僅憑已精簡到門檻內的工具摘要，不會為了使用 AI 再多發一次請求。

任務 35 的合成 fixture、替身 CLI 與完整檢查結果見
[自動壓縮與背景 QA](qa/2026-11-17-memory-compaction-and-background.zh-TW.md)。
