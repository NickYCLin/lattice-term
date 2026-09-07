import type { ChatEventEnvelope } from "./agentChat";

/** Only live turns started here may produce a cue; replayed history cannot. */
export class ChatCompletionTracker {
  private turns = new Map<string, string>();
  start(threadId: string, turnId: string) {
    this.turns.set(threadId, turnId);
  }
  cancel(threadId: string) {
    this.turns.delete(threadId);
  }
  accept(envelope: ChatEventEnvelope): boolean {
    if (
      envelope.event.kind !== "finished" ||
      this.turns.get(envelope.threadId) !== envelope.turnId
    )
      return false;
    this.turns.delete(envelope.threadId);
    return envelope.event.error === null;
  }
}
