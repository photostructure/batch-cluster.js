export function blank(s: string | undefined): boolean {
  return s == null || String(s).trim().length == 0
}

export function ensureSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s : s + suffix
}

export function toS(s: any): string {
  return s == null ? "" : String(s)
}
