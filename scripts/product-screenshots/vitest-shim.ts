// The render-test fixtures only use `vi.fn` to make inert callbacks; in the
// browser a plain function is enough.
export const vi = {
  fn: <T extends (...args: never[]) => unknown>(implementation?: T) =>
    implementation ?? (() => undefined),
};
