import { useState } from "react";
import { useI18n } from "../../i18n/context";

export interface ChatQuestion {
  id: string;
  question: string;
  isSecret?: boolean;
  options: { label: string; description: string }[];
}

export function parseChatQuestions(input: string): ChatQuestion[] {
  try {
    const value: unknown = JSON.parse(input);
    if (
      !value ||
      typeof value !== "object" ||
      !("questions" in value) ||
      !Array.isArray(value.questions)
    )
      return [];
    if (value.questions.length < 1 || value.questions.length > 3) return [];
    const seen = new Set<string>();
    return value.questions.map((question: unknown) => {
      if (
        !question ||
        typeof question !== "object" ||
        !("id" in question) ||
        !("question" in question) ||
        typeof question.id !== "string" ||
        typeof question.question !== "string" ||
        seen.has(question.id)
      )
        throw new Error();
      seen.add(question.id);
      const options =
        "options" in question && Array.isArray(question.options)
          ? question.options
          : [];
      return {
        id: question.id,
        question: question.question,
        isSecret: "isSecret" in question && question.isSecret === true,
        options: options.flatMap((option: unknown) =>
          option &&
          typeof option === "object" &&
          "label" in option &&
          typeof option.label === "string"
            ? [
                {
                  label: option.label,
                  description:
                    "description" in option &&
                    typeof option.description === "string"
                      ? option.description
                      : "",
                },
              ]
            : [],
        ),
      };
    });
  } catch {
    return [];
  }
}

export function ChatQuestions({
  input,
  onAnswer,
}: {
  input: string;
  onAnswer: (allow: boolean, message?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const questions = parseChatQuestions(input);
  const [answers, setAnswers] = useState(() => new Map<string, string>());
  const [busy, setBusy] = useState(false);
  async function answer(allow: boolean) {
    setBusy(true);
    try {
      await onAnswer(
        allow,
        allow
          ? JSON.stringify({
              answers: Object.fromEntries(
                questions.map((question) => [
                  question.id,
                  { answers: [answers.get(question.id)] },
                ]),
              ),
            })
          : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="chat-question"
      onSubmit={(event) => {
        event.preventDefault();
        void answer(true);
      }}
    >
      {questions.map((question) => (
        <fieldset key={question.id} disabled={busy}>
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label key={option.label}>
              <input
                type="radio"
                name={question.id}
                checked={answers.get(question.id) === option.label}
                onChange={() =>
                  setAnswers((current) =>
                    new Map(current).set(question.id, option.label),
                  )
                }
              />
              <span>
                {option.label}
                <small>{option.description}</small>
              </span>
            </label>
          ))}
          <input
            className="input"
            type={question.isSecret ? "password" : "text"}
            autoComplete="off"
            aria-label={question.question}
            maxLength={4096}
            value={answers.get(question.id) ?? ""}
            onChange={(event) =>
              setAnswers((current) =>
                new Map(current).set(question.id, event.target.value),
              )
            }
          />
        </fieldset>
      ))}
      {questions.length === 0 && (
        <pre className="chat-card__output">{input}</pre>
      )}
      <div className="chat-card__actions">
        <button
          type="submit"
          className="button button--primary button--sm"
          disabled={
            busy ||
            !questions.length ||
            questions.some((question) => !answers.get(question.id)?.trim())
          }
        >
          {t("chat.question.submit")}
        </button>
        <button
          type="button"
          className="button button--secondary button--sm"
          disabled={busy}
          onClick={() => void answer(false)}
        >
          {t("chat.question.cancel")}
        </button>
      </div>
    </form>
  );
}
