/**
 * Command and terminal fields must receive the keys the typist pressed.
 * iOS otherwise turns straight quotes into typographic ones, capitalizes
 * the first letter, and "corrects" POSIX punctuation.
 */

export const plainTextInputProps = {
  autoComplete: "off" as const,
  autoCorrect: "off" as const,
  autoCapitalize: "none" as const,
  spellCheck: false as const,
};

/** DOM attributes UIKit / WKWebView can map onto UITextInputTraits. */
const UIKIT_PLAIN_TEXT_ATTRIBUTES: Array<[string, string]> = [
  ["autocorrect", "off"],
  ["autocapitalize", "none"],
  ["autocomplete", "off"],
  ["spellcheck", "false"],
  ["smartquotestype", "no"],
  ["smartdashestype", "no"],
];

export function configurePlainTextInput(
  el: HTMLInputElement | HTMLTextAreaElement | null | undefined,
): void {
  if (!el) return;
  el.autocomplete = "off";
  el.spellcheck = false;
  for (const [name, value] of UIKIT_PLAIN_TEXT_ATTRIBUTES) {
    el.setAttribute(name, value);
  }
}

const CURLY_SINGLE = /[\u2018\u2019\u201A\u201B]/g;
const CURLY_DOUBLE = /[\u201C\u201D\u201E\u201F]/g;

/** Reverses iOS smart punctuation so a command still contains ' " - and --. */
export function unsweetenPunctuation(text: string): string {
  return text
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(/\u2014/g, "--")
    .replace(/\u2013/g, "-");
}
