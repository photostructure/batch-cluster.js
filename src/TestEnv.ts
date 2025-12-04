/**
 * Environment variables used by test.ts worker process.
 */
export type TestEnv = {
  RNG_SEED: string | undefined;
  FAIL_RATE: string | undefined;
  NEWLINE: string | undefined;
  IGNORE_EXIT: string | undefined;
  UNLUCKY_FAIL: string | undefined;
};
