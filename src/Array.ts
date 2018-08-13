/**
 * Remove all elements from the given array that return false from the given
 * predicate `filter`.
 */
export function filterInPlace<T>(arr: T[], filter: (t: T) => boolean): T[] {
  let j = 0
  arr.forEach((ea, i) => {
    if (filter(ea)) {
      if (i != j) arr[j] = ea
      j++
    }
  })
  arr.length = j
  return arr
}
