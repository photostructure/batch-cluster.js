import timers from "node:timers";
export const Timeout = Symbol("timeout");

export async function thenOrTimeout<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof Timeout> {
  // TODO: if timeoutMs is [1, 1000], it's probably a mistake. Should we do
  // something else in that case?
  return timeoutMs <= 1
    ? p
    : new Promise<T | typeof Timeout>((resolve, reject) => {
        let pending = true;
        const t = timers.setTimeout(() => {
          if (pending) {
            pending = false;
            resolve(Timeout);
          }
        }, timeoutMs);

        p.then(
          (result) => {
            if (pending) {
              pending = false;
              clearTimeout(t);
              resolve(result);
            }
          },
          (err: unknown) => {
            if (pending) {
              pending = false;
              clearTimeout(t);
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          },
        );
      });
}
