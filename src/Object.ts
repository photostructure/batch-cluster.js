/**
 * Only call and return the result of `f` if `obj` is defined (not null nor
 * undefined)
 */
export function map<T, R>(
  obj: T | undefined | null,
  f: (t: T) => R,
): R | undefined {
  return obj != null ? f(obj) : undefined
}

export function isFunction(obj: unknown): obj is () => unknown {
  return typeof obj === "function"
}

export function fromEntries(
  arr: [string | undefined, unknown][],
): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const [key, value] of arr) {
    if (key != null) {
      o[key] = value
    }
  }
  return o
}

export function omit<T extends Record<string, unknown>, S extends keyof T>(
  t: T,
  ...keysToOmit: S[]
): Omit<T, S> {
  const result = { ...t }
  for (const ea of keysToOmit) {
    delete result[ea]
  }
  return result
}
