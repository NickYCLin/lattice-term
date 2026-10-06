/**
 * The README's product picture: the real chat view, rail and header with the
 * app's own styles, fed scripted sample data from the public reading-list
 * notes (examples/first-session/project-notes.md). Nothing here talks to a
 * CLI, a model account or a remote host. `capture.mjs` opens it per locale.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n";
import { useI18n } from "../../src/i18n/context";
import { ChatView } from "../../src/views/ChatView";
import { NavRail } from "../../src/components/shell/NavRail";
import { ViewHeader } from "../../src/components/shell/ViewHeader";
import {
  fakeAgentApi,
  fakeAutomationsApi,
  fakeChatApi,
  fakeDefinition,
  fakeThread,
} from "../../src/app/testFixtures/agentApis";
import "../../src/styles/index.css";

interface Sample {
  preview: string;
  folder: string;
  folder2: string;
  title1: string;
  title2: string;
  title3: string;
  prompt: string;
  response: string;
  response2: string;
}

const SAMPLES: Record<string, Sample> = {
  "zh-TW": {
    preview: "開發版介面預覽 · 虛構專案與示範對話",
    folder: "閱讀清單", folder2: "網站筆記",
    title1: "整理下一輪待辦", title2: "確認網址去重規則", title3: "檢查首次使用說明",
    prompt: "請閱讀 project-notes.md，列出三個待辦的優先順序，並說明每項完成時應該看到什麼結果。先不要修改檔案。",
    response: "先修正兩個既有問題，再加入搜尋。\n\n### 1. 避免重複加入文章\n儲存相同網址時，清單維持一筆，並提醒使用者已經加入過。\n\n### 2. 修正未讀篩選\n把文章標為已讀後，它應從「未讀」清單移除，仍能在「全部文章」找到。\n\n### 3. 加入標題搜尋\n搜尋忽略大小寫；找不到符合的文章時，顯示無結果提示。\n\n**實作前先確認：** 網址去重是否要忽略追蹤參數？這會影響第一項的比對方式。",
    response2: "筆記裡還有一個決定：帶有不同追蹤參數的網址，要不要視為同一篇文章？先確認這點，再修改網址去重規則。",
  },
  "zh-CN": {
    preview: "开发版界面预览 · 虚构项目与示范对话",
    folder: "阅读清单", folder2: "网站笔记",
    title1: "整理下一轮待办", title2: "确认网址去重规则", title3: "检查首次使用说明",
    prompt: "请阅读 project-notes.md，列出三个待办的优先顺序，并说明每项完成时应该看到什么结果。先不要修改文件。",
    response: "先修正两个已有问题，再加入搜索。\n\n### 1. 避免重复加入文章\n保存相同网址时，清单保持一条，并提醒用户已经加入过。\n\n### 2. 修正未读筛选\n把文章标为已读后，它应从「未读」清单移除，仍能在「全部文章」找到。\n\n### 3. 加入标题搜索\n搜索忽略大小写；找不到符合的文章时，显示无结果提示。\n\n**实现前先确认：** 网址去重是否要忽略跟踪参数？这会影响第一项的比对方式。",
    response2: "笔记里还有一个决定：带有不同跟踪参数的网址，要不要视为同一篇文章？先确认这一点，再修改网址去重规则。",
  },
  en: {
    preview: "DEVELOPMENT PREVIEW · SCRIPTED SAMPLE DATA",
    folder: "Reading list", folder2: "Website notes",
    title1: "Plan the next three fixes", title2: "Clarify URL matching", title3: "Review the first-run guide",
    prompt: "Read project-notes.md. List the three tasks in priority order and explain how to check each one. Do not change any files yet.",
    response: "Start with the two existing bugs, then add search.\n\n### 1. Prevent duplicate articles\nSaving the same URL should keep one entry and show an already-saved message.\n\n### 2. Fix the unread filter\nMark an article as read. It should leave Unread and remain in All articles.\n\n### 3. Add title search\nSearch should ignore letter case. A query with no matches should show an empty state.\n\n**Before implementation:** decide whether URL matching should ignore tracking parameters.",
    response2: "The notes leave one product decision open: should two URLs with different tracking parameters count as the same article? Confirm this before changing URL matching.",
  },
  ja: {
    preview: "開発版 UI プレビュー · 架空のプロジェクトとサンプル会話",
    folder: "リーディングリスト", folder2: "サイトのメモ",
    title1: "次の 3 件を整理", title2: "URL の重複判定を確認", title3: "初回ガイドを確認",
    prompt: "project-notes.md を読んで、3 つのタスクを優先順に並べ、それぞれ完了時に何を確認すればよいか説明してください。ファイルはまだ変更しないでください。",
    response: "まず既存の 2 つの不具合を直し、そのあと検索を追加します。\n\n### 1. 記事の重複登録を防ぐ\n同じ URL を保存したときは 1 件のまま残し、登録済みであることを知らせます。\n\n### 2. 未読フィルターを修正\n既読にした記事は「未読」から外れ、「すべての記事」には残ります。\n\n### 3. タイトル検索を追加\n大文字と小文字を区別せずに検索し、該当がないときは結果なしと表示します。\n\n**実装前の確認：** URL の重複判定でトラッキングパラメーターを無視するかどうか決めてください。",
    response2: "メモには未決定の点が 1 つあります。トラッキングパラメーターだけが違う URL を同じ記事として扱うかどうかです。重複判定を変える前に確認してください。",
  },
  ko: {
    preview: "개발 버전 UI 미리보기 · 가상의 프로젝트와 예시 대화",
    folder: "읽기 목록", folder2: "웹사이트 메모",
    title1: "다음 할 일 3개 정리", title2: "URL 중복 기준 확인", title3: "첫 실행 안내 검토",
    prompt: "project-notes.md를 읽고 세 가지 작업의 우선순위를 정한 뒤, 각 작업이 끝났을 때 무엇을 확인해야 하는지 설명해 주세요. 아직 파일은 수정하지 마세요.",
    response: "먼저 기존 문제 두 가지를 고치고 그다음 검색을 추가합니다.\n\n### 1. 글 중복 저장 방지\n같은 URL을 저장하면 항목을 하나만 유지하고 이미 저장했다고 알려 줍니다.\n\n### 2. 읽지 않음 필터 수정\n읽음으로 표시한 글은 '읽지 않음'에서 빠지고 '전체 글'에는 남아야 합니다.\n\n### 3. 제목 검색 추가\n대소문자를 구분하지 않고 검색하며, 결과가 없으면 빈 화면 안내를 표시합니다.\n\n**구현 전 확인:** URL 중복을 판단할 때 추적 파라미터를 무시할지 정해 주세요.",
    response2: "메모에 결정되지 않은 것이 하나 있습니다. 추적 파라미터만 다른 URL을 같은 글로 볼까요? URL 중복 기준을 바꾸기 전에 확인해 주세요.",
  },
  es: {
    preview: "VISTA PREVIA DE DESARROLLO · DATOS DE EJEMPLO",
    folder: "Lista de lectura", folder2: "Notas del sitio",
    title1: "Ordenar las próximas tareas", title2: "Aclarar URLs duplicadas", title3: "Revisar la guía inicial",
    prompt: "Lee project-notes.md. Ordena las tres tareas por prioridad y explica cómo comprobar cada una. No cambies ningún archivo todavía.",
    response: "Primero los dos errores existentes; después, la búsqueda.\n\n### 1. Evitar artículos duplicados\nAl guardar la misma URL debe quedar una sola entrada y avisar de que ya estaba guardada.\n\n### 2. Corregir el filtro de no leídos\nUn artículo marcado como leído sale de «No leídos» y sigue en «Todos los artículos».\n\n### 3. Añadir búsqueda por título\nLa búsqueda ignora mayúsculas y minúsculas; sin coincidencias, muestra un estado vacío.\n\n**Antes de implementar:** decide si la comparación de URLs debe ignorar los parámetros de seguimiento.",
    response2: "Las notas dejan una decisión pendiente: ¿dos URLs que solo cambian en los parámetros de seguimiento son el mismo artículo? Confírmalo antes de cambiar la comparación de URLs.",
  },
  fr: {
    preview: "APERÇU DE DÉVELOPPEMENT · DONNÉES D’EXEMPLE",
    folder: "Liste de lecture", folder2: "Notes du site",
    title1: "Planifier les trois correctifs", title2: "Clarifier les URL en double", title3: "Relire le guide de démarrage",
    prompt: "Lis project-notes.md. Classe les trois tâches par priorité et explique comment vérifier chacune. Ne modifie encore aucun fichier.",
    response: "D’abord les deux bogues existants, ensuite la recherche.\n\n### 1. Éviter les articles en double\nEnregistrer la même URL garde une seule entrée et indique qu’elle est déjà enregistrée.\n\n### 2. Corriger le filtre « Non lus »\nUn article marqué comme lu quitte « Non lus » et reste dans « Tous les articles ».\n\n### 3. Ajouter la recherche par titre\nLa recherche ignore la casse ; sans résultat, elle affiche un état vide.\n\n**Avant de commencer :** décider si la comparaison des URL ignore les paramètres de suivi.",
    response2: "Les notes laissent une décision ouverte : deux URL qui ne diffèrent que par leurs paramètres de suivi désignent-elles le même article ? À confirmer avant de modifier la comparaison des URL.",
  },
  de: {
    preview: "ENTWICKLUNGSVORSCHAU · BEISPIELDATEN",
    folder: "Leseliste", folder2: "Website-Notizen",
    title1: "Nächste Aufgaben planen", title2: "Doppelte URLs klären", title3: "Einstiegsanleitung prüfen",
    prompt: "Lies project-notes.md. Ordne die drei Aufgaben nach Priorität und erkläre, woran man jede als erledigt erkennt. Ändere noch keine Dateien.",
    response: "Zuerst die zwei bestehenden Fehler, danach die Suche.\n\n### 1. Doppelte Artikel verhindern\nWird dieselbe URL erneut gespeichert, bleibt ein Eintrag bestehen und ein Hinweis erscheint.\n\n### 2. Filter „Ungelesen“ korrigieren\nEin als gelesen markierter Artikel verschwindet aus „Ungelesen“ und bleibt unter „Alle Artikel“.\n\n### 3. Titelsuche hinzufügen\nDie Suche ignoriert Groß- und Kleinschreibung und zeigt ohne Treffer einen leeren Zustand.\n\n**Vor der Umsetzung:** klären, ob der URL-Vergleich Tracking-Parameter ignoriert.",
    response2: "In den Notizen ist eine Entscheidung offen: Gelten zwei URLs, die sich nur in Tracking-Parametern unterscheiden, als derselbe Artikel? Bitte vor der Änderung des URL-Vergleichs klären.",
  },
  "pt-BR": {
    preview: "PRÉVIA DE DESENVOLVIMENTO · DADOS DE EXEMPLO",
    folder: "Lista de leitura", folder2: "Notas do site",
    title1: "Planejar as próximas tarefas", title2: "Definir URLs duplicadas", title3: "Revisar o guia inicial",
    prompt: "Leia project-notes.md. Coloque as três tarefas em ordem de prioridade e explique como verificar cada uma. Não altere nenhum arquivo ainda.",
    response: "Primeiro os dois erros existentes, depois a busca.\n\n### 1. Evitar artigos duplicados\nSalvar a mesma URL mantém uma única entrada e avisa que ela já foi salva.\n\n### 2. Corrigir o filtro de não lidos\nUm artigo marcado como lido sai de \"Não lidos\" e continua em \"Todos os artigos\".\n\n### 3. Adicionar busca por título\nA busca ignora maiúsculas e minúsculas; sem resultados, mostra um estado vazio.\n\n**Antes de implementar:** decidir se a comparação de URLs deve ignorar parâmetros de rastreamento.",
    response2: "As notas deixam uma decisão em aberto: duas URLs que diferem só nos parâmetros de rastreamento são o mesmo artigo? Confirme isso antes de mudar a comparação de URLs.",
  },
};

const query = new URLSearchParams(location.search);
const locale = query.get("locale") ?? "zh-TW";
const words = SAMPLES[locale] ?? SAMPLES.en;
document.documentElement.dataset.theme = "light";
document.documentElement.dataset.motion = "reduced";
document.documentElement.lang = locale;
const noop = () => {};

const threads = [
  fakeThread({
    id: "notes-codex", title: words.title1, workingDirectory: "/examples/reading-list", permission: "readOnly",
    items: [
      { type: "user", id: "example-question", text: words.prompt, at: 0 },
      { type: "text", id: "example-answer", text: words.response, assistantDefinitionId: "codex" },
    ],
  }),
  fakeThread({
    id: "notes-claude", definitionId: "claude", title: words.title2, workingDirectory: "/examples/reading-list",
    permission: "readOnly",
    items: [{ type: "text", id: "example-clarification", text: words.response2, assistantDefinitionId: "claude" }],
  }),
  fakeThread({ id: "guide-gemini", definitionId: "gemini", title: words.title3, workingDirectory: "/examples/website", permission: "readOnly" }),
];
const layout = {
  version: 1,
  folders: [{ id: "folder:reading", name: words.folder }, { id: "folder:website", name: words.folder2 }],
  placements: {
    "folder:reading": { parentId: null, order: 0 },
    "folder:website": { parentId: null, order: 1 },
    "thread:notes-codex": { parentId: "folder:reading", order: 0 },
    "thread:notes-claude": { parentId: "folder:reading", order: 1 },
    "thread:guide-gemini": { parentId: "folder:website", order: 0 },
  },
  collapsedFolderIds: [],
};
// No sign-in shown: sample data must not look like a real account.
const account = { state: "unknown" as const, label: null, method: null };
const catalog = [
  fakeDefinition({ account }),
  fakeDefinition({ id: "claude", label: "Claude Code", executable: "claude", account }),
  fakeDefinition({ id: "gemini", label: "Gemini CLI", executable: "gemini", account }),
];

function Frame() {
  const { t } = useI18n();
  // `?thread=guide-gemini` opens a new conversation with its settings shown.
  const [active, setActive] = useState(query.get("thread") ?? threads[0].id);
  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateRows: "34px 1fr", padding: "0 16px 16px", gap: 8, background: "var(--canvas)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", letterSpacing: ".07em" }}>
        <strong>LatticeTerm</strong>
        <span>{words.preview}</span>
      </div>
      <div style={{ display: "flex", gap: 8, minHeight: 0 }}>
        <NavRail current="chat" onSelect={noop} />
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
          <ViewHeader title={t("nav.chat")} description={t("nav.chat.desc")} onToggleSidebar={noop}
            sidebarCollapsed={false} showSidebarToggle={false} />
          <div style={{ flex: 1, minHeight: 0, display: "flex", border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden", background: "var(--surface)" }}>
            <ChatView agents={fakeAgentApi({ catalog })} automations={fakeAutomationsApi()} onOpenSession={noop}
              chat={fakeChatApi({ threads, activeThreadId: active, setActiveThreadId: setActive, layout })} />
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider locale={locale as never}>
    <Frame />
  </I18nProvider>,
);
