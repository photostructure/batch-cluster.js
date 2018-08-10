export function map<T, R>(obj: T | undefined, f: (t: T) => R): R | undefined {
  return obj != null ? f(obj) : undefined
}
