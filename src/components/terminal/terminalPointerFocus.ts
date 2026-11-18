import type { PointerEvent } from "react";

/** Keep a terminal/textarea focused on pointer taps; keyboard activation stays native.
 * Only buttons are protected: inputs and rename fields must still accept focus.
 */
export function preserveTerminalButtonFocus(event: Pick<PointerEvent<HTMLElement>, "target" | "preventDefault">) {
  if ((event.target as Element | null)?.closest?.("button")) event.preventDefault();
}
