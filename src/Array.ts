import { map } from "./Object"

/**
 * Remove all elements from the given array that return false from the given
 * predicate `filter`.
 */
export function filterInPlace<T>(arr: T[], filter: (t: T) => boolean): T[] {
  let j = 0
  arr.forEach((ea, i) => {
    if (filter(ea)) {
      if (i !== j) arr[j] = ea
      j++
    }
  })
  arr.length = j
  return arr
}

export function flatten<T>(arr: (T | T[])[], result: T[] = []): T[] {
  arr.forEach(ea => (Array.isArray(ea) ? result.push(...ea) : result.push(ea)))
  return result
}

export function sortNumeric(arr: number[]): number[] {
  return arr.sort((a, b) => a - b)
}

/**
 * Treat an array as a round-robin list, starting from `startIndex`.
 */
export function rrFind<T>(
  arr: T[],
  startIndex: number,
  predicate: (t: T, arrIdx: number, iter: number) => boolean
): undefined | T {
  return map(rrFindResult(arr, startIndex, predicate), ea => ea.result)
}

export function rrFindResult<T>(
  arr: T[],
  startIndex: number,
  predicate: (t: T, arrIdx: number, iter: number) => boolean
): undefined | { result: T; index: number } {
  for (let iter = 0; iter < arr.length; iter++) {
    const arrIdx = (iter + startIndex) % arr.length
    const t = arr[arrIdx]
    if (predicate(t, arrIdx, iter)) return { result: t, index: arrIdx }
  }
  return
}
