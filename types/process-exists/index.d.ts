// Type definitions for process-exists
// Project: https://github.com/sindresorhus/process-exists
// Definitions by: Matthew McEachen <https://github.com/mceachen>
// Definitions: https://github.com/DefinitelyTyped/DefinitelyTyped

interface ProcessExistsStatic {
  (pid: number | string): Promise<boolean>
  all(input: (number | string)[]): Promise<Map<string, boolean>>
  filterExists(input: (number | string)[]): Promise<(number | string)[]>
}

const ProcessExists: ProcessExistsStatic

export = ProcessExists
