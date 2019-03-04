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
