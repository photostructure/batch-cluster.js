/**
 * Only call and return the result of `f` if `obj` is defined (not null nor
 * undefined)
 */
export function map<T, R>(
  obj: T | undefined | null,
  f: (t: T) => R
): R | undefined {
  return obj != null ? f(obj) : undefined
}

export function isFunction(obj: any): obj is Function {
  return typeof obj === "function"
}

export function orElse<T>(obj: T | undefined, defaultValue: T | (() => T)): T {
  return obj != null
    ? obj
    : isFunction(defaultValue)
    ? defaultValue()
    : defaultValue
}
