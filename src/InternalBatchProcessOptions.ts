import { BatchClusterOptions, WithObserver } from "./BatchClusterOptions";
import { BatchProcessOptions } from "./BatchProcessOptions";

export interface InternalBatchProcessOptions
  extends BatchProcessOptions,
    BatchClusterOptions,
    WithObserver {
  passRE: RegExp;
  failRE: RegExp;
}
