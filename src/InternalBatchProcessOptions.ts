import { BatchClusterOptions } from "./BatchClusterOptions"
import { BatchProcessOptions } from "./BatchProcessOptions"

export interface InternalBatchProcessOptions
  extends BatchProcessOptions,
    BatchClusterOptions {
  readonly passRE: RegExp
  readonly failRE: RegExp
}
