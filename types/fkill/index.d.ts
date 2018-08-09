// Type definitions for fkill
// Project: https://github.com/sindresorhus/fkill
// Definitions by: Matthew McEachen <https://github.com/mceachen>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped

interface FkillStatic {
  (
    input: number | string | number[] | string[],
    options?: {
      force?: boolean
      tree?: boolean
      ignoreCase?: boolean
    }
  ): Promise<boolean>
}

const fkill: FkillStatic

export = fkill
