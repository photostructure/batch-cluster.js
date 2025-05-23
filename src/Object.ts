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

export function isFunction(obj: any): obj is () => any {
  return typeof obj === "function"
}

export function fromEntries(arr: [string | undefined, any][]) {
  const o: any = {}
  for (const [key, value] of arr) {
    if (key != null) {
      o[key] = value
    }
  }
  return o
}

export function omit<T extends Record<string, any>, S extends keyof T>(
  t: T,
  ...keysToOmit: S[]
): Omit<T, S> {
  const result = { ...t }
  for (const ea of keysToOmit) {
    delete result[ea]
  }
  return result
}
