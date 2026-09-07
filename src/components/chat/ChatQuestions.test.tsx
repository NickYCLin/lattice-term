import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../i18n";
import { ChatQuestions, parseChatQuestions } from "./ChatQuestions";

describe("chat questions", () => {
  it("renders arbitrary question ids without reading object prototype values", () => {
    const input = JSON.stringify({
      questions: [
        { id: "__proto__", question: "First?" },
        { id: "constructor", question: "Second?" },
      ],
    });
    const markup = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ChatQuestions input={input} onAnswer={async () => {}} />
      </I18nProvider>,
    );
    expect(markup).toContain("First?");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("[object Object]");
  });
  it("keeps real options and secret-input hints", () => {
    const questions = parseChatQuestions(
      JSON.stringify({
        questions: [
          {
            id: "choice",
            question: "Which one?",
            isSecret: true,
            options: [{ label: "A", description: "First" }],
          },
        ],
      }),
    );
    expect(questions).toEqual([
      {
        id: "choice",
        question: "Which one?",
        isSecret: true,
        options: [{ label: "A", description: "First" }],
      },
    ]);
  });
  it("rejects malformed, oversized or ambiguous question groups", () => {
    expect(parseChatQuestions("broken")).toEqual([]);
    expect(
      parseChatQuestions(
        JSON.stringify({
          questions: Array(4).fill({ id: "q", question: "?" }),
        }),
      ),
    ).toEqual([]);
    expect(
      parseChatQuestions(
        JSON.stringify({
          questions: Array(2).fill({ id: "q", question: "?" }),
        }),
      ),
    ).toEqual([]);
  });
});
