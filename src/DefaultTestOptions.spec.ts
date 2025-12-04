import { BatchClusterOptions } from "./BatchClusterOptions";

const bco = new BatchClusterOptions();

export const DefaultTestOptions = {
  ...bco,
  maxProcs: 4,
  versionCommand: "version",
  pass: "PASS",
  fail: "FAIL",
  exitCommand: "exit",
  // don't reduce onIdleInterval: it shouldn't be required to finish! See
  // https://github.com/photostructure/batch-cluster.js/issues/15
  // onIdleIntervalMillis: xxx
  maxTasksPerProcess: 5,
  taskTimeoutMillis: 250,
  // we shouldn't need these overrides...
  // ...(isCI ? { streamFlushMillis: bco.streamFlushMillis * 3 } : {}),
  // onIdleIntervalMillis: 1000,
};
