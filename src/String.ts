export function blank(s: unknown): boolean {
  return s == null || toS(s).trim().length === 0
}

export function notBlank(s: unknown): boolean {
  return !blank(s)
}

export function toNotBlank(s: unknown): string | undefined {
  const result = toS(s).trim()
  return result.length === 0 ? undefined : result
}

export function ensureSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s : s + suffix
}

export function toS(s: unknown): string {
  /* eslint-disable-next-line @typescript-eslint/no-base-to-string */
  return s == null ? "" : s.toString()
}
