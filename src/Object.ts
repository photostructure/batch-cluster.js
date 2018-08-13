
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

