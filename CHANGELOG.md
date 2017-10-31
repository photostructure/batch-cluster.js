# Versioning

## The `MAJOR` or `API` version is incremented for

* 💔 Non-backwards-compatible API changes

## The `MINOR` or `UPDATE` version is incremented for

* ✨ Backwards-compatible features

## The `PATCH` version is incremented for

* 🐞 Backwards-compatible bug fixes
* 📦 Minor packaging changes

# Changelog

## v1.5.0

* ✨ `.running()` works correctly for PIDs with different owners now.
* 📦 `yarn upgrade --latest`

## v1.4.2

* 📦 Ran code through `prettier` and delinted
* 📦 Massaged test assertions to pass through slower CI systems

## v1.4.1

* 📦 Replaced an errant `console.log` with a call to `log`.

## v1.4.0

* 🐞 Discovered `maxProcs` wasn't always utilized by `onIdle`, which meant in
  certain circumstances, only 1 child process would be servicing pending
  requests. Added breaking tests and fixed impl.

## v1.3.0

* 📦 Added tests to verify that the `kill(0)` calls to verify the child
  processes are still running work across different node version and OSes
* 📦 Removed unused methods in `BatchProcess` (whose API should not be accessed
  directly by consumers, so the major version remains at 1)
* 📦 Switched to yarn and upgraded dependencies

## v1.2.0

* ✨ Added a configurable cleanup signal to ensure child processes shut down on `.end()`
* 📦 Moved child process management from `BatchCluster` to `BatchProcess`
* ✨ More test coverage around batch process concurrency, reuse, flaky task
  retries, and proper process shutdown

## v1.1.0

* ✨ `BatchCluster` now has a force-shutdown `exit` handler to accompany the
  graceful-shutdown `beforeExit` handler. For reference, from the [Node
  docs](https://nodejs.org/api/process.html#process_event_beforeexit):
  
> The 'beforeExit' event is not emitted for conditions causing explicit
  termination, such as calling process.exit() or uncaught exceptions.

* ✨ Remove `Rate`'s time decay in the interests of simplicity

## v1.0.0

* ✨ Integration tests now throw deterministically random errors to simulate
  flaky child procs, and ensure retries and disaster recovery work as expected.
* ✨ If the `processFactory` or `versionCommand` fails more often than a given
  rate, `BatchCluster` will shut down and raise exceptions to subsequent
  `enqueueTask` callers, rather than try forever to spin up processes that are
  most likely misconfigured.
* ✨ Given the proliferation of construction options, those options are now
  sanity-checked at construction time, and an error will be raised whose message
  contains all incorrect option values.

## v0.0.2

* ✨ Added support and explicit tests for [CR LF, CR, and
  LF](https://en.wikipedia.org/wiki/Newline) encoded streams from exec'ed
  processes
* ✨ child processes are ended after `maxProcAgeMillis`, and restarted as needed
* 🐞 `BatchCluster` now practices good listener hygene for `process.beforeExit`

## v0.0.1

* ✨ Extracted implementation and tests from
  [exiftool-vendored](https://github.com/mceachen/exiftool-vendored.js)

