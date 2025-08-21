import { toNotBlank } from "./String";

/**
 * When we wrap errors, an Error always prefixes the toString() and stack with
 * "Error: ", so we can remove that prefix.
 */
export function tryEach(arr: (() => void)[]): void {
  for (const f of arr) {
    try {
      f();
    } catch {
      //
    }
  }
}

export function cleanError(s: unknown): string {
  return String(s)
    .trim()
    .replace(/^error: /i, "");
}

export function asError(err: unknown): Error {
  return err instanceof Error
    ? err
    : new Error(
        toNotBlank(
          err != null && typeof err === "object" && "message" in err
            ? err?.message
            : undefined,
        ) ??
          toNotBlank(err) ??
          "(unknown)",
      );
}
