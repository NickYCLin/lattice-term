export type NativeReviewTarget = { type: "uncommittedChanges" } | { type: "baseBranch"; branch: string } | { type: "commit"; sha: string };
export type NativeChatAction = { kind: "compact" } | { kind: "review"; target: NativeReviewTarget };
