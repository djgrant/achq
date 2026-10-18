/** Runs work for the same key one at a time, in the order it was asked for. */
export const createSerial = () => {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const next = (chains.get(key) ?? Promise.resolve()).then(run, run);
    chains.set(key, next);
    const done = () => {
      if (chains.get(key) === next) chains.delete(key);
    };
    next.then(done, done);
    return next;
  };
};
