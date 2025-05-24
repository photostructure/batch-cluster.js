import { BatchClusterOptions, WithObserver } from "./BatchClusterOptions"
import { ChildProcessFactory } from "./ChildProcessFactory"
import { InternalBatchProcessOptions } from "./InternalBatchProcessOptions"

export type CombinedBatchProcessOptions = BatchClusterOptions &
  InternalBatchProcessOptions &
  ChildProcessFactory &
  WithObserver
