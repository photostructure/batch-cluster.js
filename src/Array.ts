/**
 * Remove all elements from the given array that return false from the given
 * predicate `filter`.
 */
export function filterInPlace<T>(arr: T[], filter: (t: T) => boolean): T[] {
  const len = arr.length
  let j = 0
  // PERF: for-loop to avoid the additional closure from a forEach
  for (let i = 0; i < len; i++) {
    const ea = arr[i]!
    if (filter(ea)) {
      if (i !== j) arr[j] = ea
      j++
    }
  }
  arr.length = j
  return arr
}

export function count<T>(
  arr: T[],
  predicate: (t: T, idx: number) => boolean,
): number {
  let acc = 0
  for (let idx = 0; idx < arr.length; idx++) {
    if (predicate(arr[idx]!, idx)) acc++
  }
  return acc
}
