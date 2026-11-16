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
      "pinned": false
    }
  ]
}
```

- `kind` 為 `user`、`feedback`、`project`、`reference`；**類型與儲存範圍獨立**。
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

記憶受管理區塊上限 **16 KiB**，AGENTS.md 整份仍受共用規則的 **32 KiB** 限制。
超限會保留全部中立條目、顯示需同步，阻止帶著過期輸出的新啟動；不靜默截斷，
也不實作任務 35 的自動壓縮。缺失／重複標記、標記落在程式碼圍欄、symlink 或
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
