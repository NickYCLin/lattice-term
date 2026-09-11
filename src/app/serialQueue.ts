/**
 * Runs async tasks one at a time, in the order they were queued. A failed
 * task does not block the ones after it.
 *
 * The SFTP backend allows one directory listing per session and rejects a
 * second one outright, so a pane that can ask twice (opening a folder while a
 * refresh is running, React re-running an effect) must queue its listings.
 */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
