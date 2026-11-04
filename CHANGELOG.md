# Changelog

## Versioning

See [Semver](http://semver.org/).

### The `MAJOR` or `API` version is incremented for

- 💔 Non-backwards-compatible API changes

### The `MINOR` or `UPDATE` version is incremented for

- ✨ Backwards-compatible features

### The `PATCH` version is incremented for

- 🐞 Backwards-compatible bug fixes

- 📦 Minor packaging changes

## [Unreleased (minor)]

- ✨ A task whose timeout timer runs late because the parent's event loop was blocked now keeps waiting while the child's output read after the deadline is still arriving, for at most as long as the timer ran late. Output counts as still arriving if more is read within `streamFlushMillis` of the previous check, or while batch-cluster is still handling output it read: a partial line it will flush, or a pass or fail token while the task waits to settle. A child that sent nothing more times out as soon as the block ends. Without a block the timer runs at most a few milliseconds late, so a task times out within a few milliseconds of its deadline, as before.
- 🐞 A task whose child replies while the parent's event loop is blocked past the task's deadline now resolves instead of rejecting with `TaskTimeoutError`, if the parent can read the rest of the reply within as long as the block overran the deadline. This includes replies larger than the pipe buffer, and stderr failure tokens without a trailing newline when `shouldIgnoreStderrLine` is set. Previously, a reply that arrived during a 1.5-second synchronous block with `taskTimeoutMillis: 500` was timed out. If the child exits during the block, the task now rejects with "Process terminated before task completed", as when a child exits mid-task, instead of `TaskTimeoutError`, and no `taskTimeout` event is emitted.
- 🐞 A startup task whose process ends before it replies, whether its child exits or the process is ended, now rejects with "Process terminated before task completed" instead of staying pending forever. It emits no `startError`; `childEnd` reports the exit. A startup task that times out now emits one `startError` instead of two.
- 🐞 Health checks no longer restart a process's idle clock, so `maxIdleMsPerProcess` retires a process that has run only health checks since its last task. Previously, a `healthCheckIntervalMillis` shorter than `maxIdleMsPerProcess` kept idle processes, and their children, alive until something else ended them.

## [19.5.0] - 2026-10-06

- 🐞 With `isRetirementRequest` set, or `shouldIgnoreStderrLine` for stderr, a task now receives the complete lines from one stdout or stderr chunk in a single `onStdout()` or `onStderr()` call, instead of one call per line. Each call rescans the task's accumulated output, so a task that printed 100,000 lines now takes about 55 ms instead of 30 seconds. `taskData` events and a task's stderr warning logs now cover these batches, as they cover chunks without these options. With `streamFlushMillis: 0`, output after a completion token in the same chunk now reaches the parser, including an unterminated fragment flushed before parsing; at zero delay that fragment previously ended the worker with `stdout.error`.
- 🐞 A multi-byte UTF-8 character split across two stdout or stderr chunks no longer reaches the task as U+FFFD replacement characters. Stdout chunks were decoded separately when `isRetirementRequest` was unset; stderr chunks were decoded separately when both `isRetirementRequest` and `shouldIgnoreStderrLine` were unset. ExifTool's `-listx` output contained `Кана��ов` where it printed `Каналов`.
- ✨ `Task.onStdout()`, `Task.onStderr()`, `taskData`, and `noTaskData` now always receive decoded strings, never `Buffer`s. Listeners or subclasses that need a `Buffer` must convert with `Buffer.from(data)`; including those strings in a `Buffer.concat([...])` call throws a `TypeError`.
- 🐞 When both pass and fail tokens match a task's stdout buffer, the earlier match decides, with same-position ties passing. `FAIL\nPASS\n` now fails even when delivered in one chunk. With `pass: "OK"` and `fail: "NOT OK"`, `NOT OK` now fails instead of matching the overlapping pass token first. Later stdout is retained for parsing without changing that decision; stderr failure tokens still take precedence. Stdout matching and token removal no longer advance shared `RegExp.lastIndex` values.

## [19.4.1] - 2026-09-24

- 🐞 `maxProcAgeMillis` may now be less than `taskTimeoutMillis`. A child that reaches `maxProcAgeMillis` during a task already finished that task before being recycled, so the check rejected configurations that work.
- 🐞 The `BatchCluster` constructor now rejects a `maxProcAgeMillis` below `spawnTimeoutMillis` when `taskTimeoutMillis` is 0. Previously it skipped that check whenever task timeouts were disabled.

## [19.4.0] - 2026-09-24

- ✨ `Task.onStderr()` now logs a task's stderr at warn, instead of the stream handler logging it before the task sees it. A `Task` subclass that removes lines it understands before calling `super.onStderr()` keeps those lines out of the log. These log lines now name the task (`Task.toString()`) instead of the process. Stderr that arrives with no pending task is still logged with the process name.

## [19.3.2] - 2026-09-24

- 🐞 A timed-out task now rejects with `TaskTimeoutError` even when a `taskTimeout` listener ends its process. Previously the listener's `end()` made the task reject later with a generic "Process terminated before task completed" error, and `childEnd` recorded the listener's reason instead of `"timeout"`.

## [19.3.0] - 2026-09-23

- ✨ Added `Task.resetTimeout()`, so a worker that reports progress can restart its task's `taskTimeoutMillis` while the task advances. Timeouts now reject with the exported `TaskTimeoutError`.
- ✨ `BatchProcess.end()` now resolves only after the child exits, and rejects if the child is still running 5 seconds after termination. `context.end()` in `taskData` listeners returns the same promise. `BatchCluster.end()` rejects, and doesn't emit `end`, while a child it spawned is still running. A child keeps its `maxProcs` slot until it exits.
- 🐞 A task rejected while queued is removed from the queue and never executed.

## [19.2.0] - 2026-09-14

- ✨ Added `isRetirementRequest` to consume worker retirement control lines and recycle the worker after its current task settles. Recognized lines are excluded from task output, events, and stderr logging. Added `BatchProcess.requestRetirement()`, `retirementRequested`, and the expected termination reason `"retired"`.
- 🐞 Preserve failure tokens discovered while flushing buffered output before task parsing, including when `shouldIgnoreStderrLine` is enabled.
- 🐞 Flush orphaned output fragments after `streamFlushMillis` so they cannot strand an idle worker or block queued tasks indefinitely.

## [19.1.0] - 2026-09-06

- ✨ Added `shouldIgnoreStderrLine` to discard known benign stderr lines before logging or routing.

## [19.0.1] - 2026-08-06

- 📦 Restricted the published package to compiled library output and standard package documentation, excluding development configuration and maintainer-only files.
- 📦 Hardened releases with signed tags and exact-artifact verification before npm staging.

## [19.0.0] - 2026-07-31

This release closes several ways a child process could be leaked, and several ways a task's promise could be dropped. It is major because some fixes change runtime behavior for every consumer, even though no API was removed or renamed.

- 💔 **BREAKING**: outstanding work now keeps the event loop alive.

  Everything this library owns is deliberately unref'd, so an idle cluster never stops a script from exiting. But unsettled _work_ held nothing open either: when the loop drained, `beforeExit` fired and `end()` tore down a task the caller was still awaiting. A queued task's promise was **abandoned entirely** — node exited 0 with no error at all — and an assigned task was rejected with "Process terminated before task completed". The only thing that ever prevented this was the per-task timeout timer, which doesn't exist at the default `taskTimeoutMillis` of 0.

  This is longstanding, not new in v19. An idle cluster still holds nothing, so the `unrefStreams` contract is unchanged. One consequence: if a child wedges and you haven't set `taskTimeoutMillis`, your process now stays alive rather than exiting silently. A visible hang beats losing work without a diagnostic, but it is a good reason to set that option.

- 💔 **BREAKING**: `end()` is a barrier. It previously drained the pool and resolved, which is not the same as "every child is gone": an in-flight `processFactory()` could hand back a live child afterwards, and a recycling process could still be seconds into its graceful shutdown. Either way, `await bc.end(); process.exit(0)` could orphan a child.

  Explicit `end()` now waits for in-flight spawns and recycling, so it can take longer than it used to — and deliberately has no deadline, because until a factory returns we cannot know whether it already spawned a child. A factory that never settles keeps explicit shutdown pending.

  Automatic cleanup on `beforeExit` stays bounded by `spawnTimeoutMillis`, since process exit can't wait forever on an opaque factory. When that bound expires, every child known to be alive is force-killed and any task still waiting on those terminations is rejected — unless you set `cleanupChildProcs: false`, which means you handle PID cleanup yourself.

- 💔 **BREAKING**: `end()` rejects tasks still queued, with `BatchCluster.end() was called before this task could be assigned: <command>`. Nothing settled them before, so calling `end()` with work outstanding now yields rejections where you previously got promises that never settled.

- 💔 **BREAKING**: `maxFailedTasksPerProcess` defaults to `0` (disabled), and works when you set it.

  `failedTaskCount` was never incremented, so the previous default of `2` never recycled anything. Rather than silently enabling that rule for everyone, it is now off by default: a rejected task usually means bad input rather than a sick child, and it counts failures over the process's whole lifetime, so a long-lived child would be recycled after any two bad inputs, ever. If you set it explicitly, expect more churn and `"broken"` in `childEndCounts`. Prefer `healthCheckCommand` if you can ask the child directly.

- 💔 **BREAKING**: `kill()` returns `false` on `EPERM` instead of throwing, matching how it already handled `ESRCH`; unrecognized codes still throw. Callers signal lists of pids in loops, and one pid we aren't permitted to signal stranded every pid after it.

- 💔 **BREAKING** (TypeScript only): `killProcessGroup` is a required property of the exported `InternalBatchProcessOptions` and `CombinedBatchProcessOptions` types, so code building either by hand needs the new field. Passing options to the `BatchCluster` constructor is unaffected.

- ✨ Added the `killProcessGroup` option (default `false`) and exported `killGroup()`.

  Enable it if your `processFactory` uses `detached: true`, which makes each child its own process group leader: shutdown then keeps ownership of that group even after the leader exits, so grandchildren are cleaned up too. Safe but pointless for non-detached children — the group signal simply fails and we signal the child directly. Windows has no POSIX process groups and ignores it.

- 🐞 Fixed two outright child-process leaks. If `new BatchProcess()` threw after the factory returned a live child — a factory whose `stdio` omits stdin or stdout, or a `childStart` listener that throws — the child never entered the pool, leaving it invisible to `pids()`, recycling, `end()`, and the exit backstop, one orphan per spawn retry, surviving even the parent's exit. And a child spawned while `end()` was already draining joined a pool nothing would drain again.

- 🐞 The exit backstop now tracks every child spawned and not yet seen to exit, rather than current pool membership, so an abrupt `process.exit()` during shutdown or recycling can't leave one behind. This supersedes the PID-snapshot workaround from v17.3.1.

- 🐞 A consumer-supplied `logger` that throws can no longer strand a child: cleanup now runs before the log, and a termination that rejects for any reason force-kills the child before it is treated as finished.

- 🐞 `vacuumProcs()` catches per-process `end()` rejections, as `closeChildProcesses()` always has. Its only caller discards the promise, so a throwing `childEnd` listener became an unhandled rejection — killing the host process and orphaning every child then mid-recycle.

- 🐞 An IPC `disconnect` is no longer treated as an exit. It only means the channel closed, but it made `running()` false, which skipped both the SIGTERM and the SIGKILL. Children from an IPC-enabled factory (`stdio: [..., "ipc"]` or `fork()`) that disconnect while running are now terminated.

- 📦 The published package no longer includes the spec suite's subprocess fixtures (`*-helper.js`). They require `dist/test.js`, which was already excluded, so they were broken weight in the tarball.

## [18.0.0] - 2026-06-03

- 💔 **BREAKING**: Raised the minimum supported Node.js version to `>=22`. Node 20 reached end-of-life, so it is no longer supported or tested. Stay on v17 if you must run on Node 20.

- 📦 Upgraded the build to TypeScript 6.0 and refreshed the dev toolchain. Adapted to three TS 6.0 behavior changes: `moduleResolution` switched from the deprecated `"node"` to `"bundler"` (the recommended path for `module: commonjs`), `@types` packages are now listed explicitly in `compilerOptions.types` since they are no longer auto-discovered, and `@sinonjs/fake-timers` now ships its own types (dropping the redundant `@types/sinonjs__fake-timers`). The published JavaScript and type declarations are unchanged.

- 📦 Updated GitHub Actions workflow pins and the `pinact` installation step.

## [17.3.1] - 2026-02-21

- 🐞 Fixed orphaned child processes after `end()`. When `end()` was called (either explicitly or via the `beforeExit` handler), the synchronous `process.on("exit")` SIGKILL backstop was removed before async cleanup completed. If the parent process exited before graceful termination finished, child processes survived as orphans. The fix snapshots live PIDs before cleanup begins and keeps the backstop registered until async teardown succeeds.

## [17.3.0] - 2026-02-07

- ✨ Added `findStreamFlushMillis()` to auto-discover the minimum reliable `streamFlushMillis` value for a given child process on the current operating system and hardware. Uses a three-phase search (coarse binary search, validation, confirmation); callers should apply their own additive headroom for load spikes.

## [17.2.0] - 2026-02-06

- ✨ Added `exitCode` and `exitSignal` properties to `BatchProcess` that are always populated when a child process exits. Access these in `childEnd` event handlers for complete diagnostic information about how processes terminated.

- ✨ Added `unexpectedExit` getter to `BatchProcess` that returns `true` if the process exited due to a crash, error, or timeout (rather than proactive management like recycling). Use this to distinguish between expected non-zero exit codes and actual problems.

- ✨ Exported `ExpectedTerminationReasons` constant listing reasons that indicate managed shutdowns (`"worn"`, `"old"`, `"idle"`, etc.) vs unexpected exits.

## [17.1.0] - 2026-01-16

- ✨ Added `cleanupChildProcsOnExit` option (defaults to `true`) to control whether BatchCluster registers `beforeExit` and `exit` handlers for automatic child process cleanup.

  Set to `false` if you want to manage process cleanup yourself, or if these handlers interfere with your application's exit behavior.

- 🐞 Fixed the `exit` handler to synchronously kill child processes. The previous implementation called an async method, which doesn't work in `exit` handlers (only synchronous operations are allowed).

## [17.0.0] - 2026-01-09

- 💔 **BREAKING**: Added `unrefStreams` option (defaults to `true`) that unreferences child process stdio streams.

  Previously, even though `proc.unref()` was called on child processes, the stdio streams (stdin, stdout, stderr) kept the parent Node.js process alive, requiring explicit `.end()` calls.

  With `unrefStreams: true` (the new default), scripts can now exit naturally without calling `.end()`. Child processes are cleaned up automatically when the parent exits.

  To restore the previous behavior where the parent process stays alive until `.end()` is called:

  ```typescript
  new BatchCluster({ unrefStreams: false, ... });
  ```

  Fixes [exiftool-vendored#319](https://github.com/photostructure/exiftool-vendored.js/discussions/319).

## [16.0.0] - 2025-12-05

- 💔 **BREAKING**: Removed `maxReasonableProcessFailuresPerMinute` option and fatal shutdown on spawn failures.

  Spawn failures now log warnings and retry (rate-limited by `minDelayBetweenSpawnMillis`) instead of calling `endCluster()`. This fixes [exiftool-vendored#312](https://github.com/photostructure/exiftool-vendored.js/issues/312) where task timeouts were incorrectly triggering cluster shutdown.

  Also removed: `startErrorRatePerMinute` from stats, `endCluster` callback from `BatchClusterEventCoordinator`.

- 💔 **BREAKING**: `fatalError` event was removed (as it is never broadcast anymore--see above!)

- 💔 **BREAKING**: Changed the default value of `taskTimeoutMillis` from 10 seconds to 0 (disabled).

  There is no universally safe default for task timeouts--the appropriate value depends entirely on your application's workload. A 10-second default could cause legitimate long-running tasks (like, hypothetically, extraction of embedded metadata in videos) to fail unnecessarily.

  If you rely on task timeouts, explicitly set `taskTimeoutMillis` to a value appropriate for your use case (2-10x longer than expected task duration under typical load).

- 💔 **BREAKING**: Removed unused `Rate` class

- 💔 TypeScript compilation now targets ES2022 with ESNext.Disposable. This _shouldn't_ impact anyone, as we already require Node.js v20+.

- 📦 Added Node.js v25 to the test matrix

- 🐞 Fixed: `stdin.write()` errors now properly end the process instead of leaving a broken process in the pool

## [15.0.1] - 2025-08-26

"This time, with feeling"

- 📦 v15.0.0 automated the release to use OIDC 👍, but the `compile` prerequisite was missed 🤦, so v15.0.0 has _no code in it_ 🪹. v15.0.1 is _better_! It _has code_!

## [15.0.0] - 2025-08-25

- 💔 Deleted the standalone `pids()` function and associated code (including the ProcpsChecker). This function was exported but only used internally by tests. This fixes the [issue #58](https://github.com/photostructure/batch-cluster.js/issues/58) (by deleting the unused code! _the best kind of bugfix_). Thanks for the report, [Zaczero](https://github.com/Zaczero)!

- 💔 Dropped official support for [Node v23, which is EOL](https://nodejs.org/en/about/previous-releases).

- 📦 Simplified `prettier` config to accept all defaults -- this added semicolons to every file.

## [14.0.0] - 2025-05-26

- 💔 Dropped official support for Node v14, v16, and v18. Minimum Node.js version is now v20.

- ✨ Added startup validation for procps availability: `BatchCluster` now throws `ProcpsMissingError` during construction if the required `ps` command (or `tasklist` on Windows) is not available. This provides clear, actionable error messages instead of cryptic runtime failures. Resolves [#13](https://github.com/photostructure/batch-cluster.js/issues/13) and [#39](https://github.com/photostructure/batch-cluster.js/issues/39).

- 📦 Significant internal refactoring to improve maintainability:
  - Extracted process management logic into dedicated classes (`ProcessPoolManager`, `TaskQueueManager`, `ProcessHealthMonitor`, `StreamHandler`, `ProcessTerminator`)
  - Implemented strategy pattern for health checking logic
  - Improved type safety by replacing `any` with `unknown` throughout the codebase
  - Enhanced error handling and process lifecycle management

## [13.0.0] - 2024-02-10

- 💔 Dropped official support for [Node v16, which is EOL](https://nodejs.org/en/blog/announcements/nodejs16-eol/).

- 💔 Several methods, including BatchCluster#pids() were changed from async to sync (as they were needlessly async).

- 📦 A number of timeout options can now be validly 0 to disable timeouts:
  - `spawnTimeoutMillis`
  - `taskTimeoutMillis`

- 📦 Added eslint `@typescript-eslint/await-thenable` rule and delinted.

- 📦 Updated development dependencies and rebuilt docs

## [12.1.0] - 2023-04-11

- 🐞 `pidExists` now handles `EPERM` properly (previous implementation would
  mischaracterize pids as being dead due to insufficient permissions)

- 📦 Updated development dependencies and rebuilt docs

## [12.0.0] - 2023-02-02

- 💔/✨ `pidExists` and `killPid` are no longer `async`, as process management
  is now performed via `node:process.kill()`, instead of forking `ps` or `tasklist`.

- 📦 Updated development dependencies and rebuilt docs

## [11.0.0] - 2022-08-20

- 💔 Drop official support for Node 12: [EOL was 2022-04-30](https://github.com/nodejs/release#end-of-life-releases)

## [10.4.3] - 2022-08-20

- 🐞 Fix support for zero value of `maxProcAgeMillis`

- 📦 Updated development dependencies and rebuilt docs

## [10.4.2] - 2022-04-29

- 🐞 Fix [`unref` is not a function](https://github.com/photostructure/batch-cluster.js/issues/16)

- 📦 Updated development dependencies and rebuilt docs

## [10.4.1] - 2022-04-03

- 📦 Improved concurrent event `Rate` measurement.

## [10.4.0] - 2022-03-28

- ✨ If `healthCheckCommand` is set and any task fails, that child process will
  have a health check run before being put back into rotation.

- 📦 Updated development dependencies and rebuilt docs

## [10.3.2] - 2022-03-02

- 🐞 `BatchCluster#maybeSpawnProcs` in prior versions could spawn too many
  processes, especially if process startup was slow. Heuristics for when to
  spawn new processes now take into account pending task length and processes
  busy due to initial setup.

- 📦 `BatchCluster.vacuumProcs` returns a promise that is only fulfilled after
  all reaped child processes have completed `BatchProcess.#end`.

- 📦 `BatchProcess.whyNotHealthy` can now return `startError`.

- 📦 `childEnd` is now emitted only after the child process exits

- 📦 `BatchCluster.#onIdle` is debounced during the same event loop

- 📦 Added startup and shutdown spec assertions

- 📦 Updated development dependencies and rebuilt docs

## [10.3.1] - 2022-02-27

- 📦 Add `Rate.msSinceLastEvent`

- 📦 Adjusted `streamFlushMillis` to remove `onTaskData` errors in CI.

## [10.3.0] - 2022-02-25

- ✨ Exported `Rate`. You might like it.

- ✨ When child processes emit to `stdout` or `stderr` with no current task,
  prior versions would emit an `internalError`. These are now given their own
  new `noTaskData` events. Consumers may want to bump up `streamFlushMillis` if
  they see this in production.

- 🐞/📦 Increased defaults for `streamFlushMillis`, added tests to verify `noTaskData` events don't happen in CI.

- 📦 Normalized node imports

## [10.2.0] - 2022-02-25

- ✨/📦 Set `minDelayBetweenSpawnMillis = 0` to fork child processes as soon as
  they are needed (rather than waiting between `spawn` calls)

- ✨/📦 Set `maxReasonableProcessFailuresPerMinute = 0` to disable process start
  error rate detection.

- ✨/📦 New `fatalError` event emitted when
  `maxReasonableProcessFailuresPerMinute` is exceeded and the instance shuts
  itself down.

- 📦 New simpler `Rate` implementation with better time decay handling

- 📦 Several jsdoc improvements, including exporting `WhyNotHeathy` and
  `WhyNotReady`

## [10.1.1] - 2022-02-24

- 🐞 Fixed [issue
  #15](https://github.com/photostructure/batch-cluster.js/issues/15) by
  restoring the call to `#onIdleLater` when tasks settle.

- 🐞 Fixed issue with `setMaxProcs` which resulted in all idle processes being
  reaped

- 📦 The `idle` event was removed. _You weren't using it, though, so I'm not
  bumping major._

- 📦 Process shutdown is handled more gracefully with new `thenOrTimeout`
  (rather than the prior `Promise.race` call which resulted in a dangling
  timeout)

- 📦 Updated development dependencies and rebuilt docs

## [10.1.0] - 2022-02-23

- 📦 `.end()` and `.closeChildProcesses()` closes all child processes in parallel

## [10.0.1] - 2022-02-12

- 📦 Export `BatchProcess` interface

## [10.0.0] - 2022-02-12

- ✨ Process state improvements

- 💔 Renamed event s/childExit/childEnd/
- 💔 `childEnd` and `childStart` events receive BatchProcess instances now
- 💔 Renamed healthy state s/dead/ended/
- 📦 Made BatchProcess.whyNotHealthy persistent
- 📦 Added several more WhyNotHealthy values
- 📦 Perf: filterInPlace and count use for loops rather than closures
- 📦 Added spec to verify `.end` rejects long-running pending tasks
- 📦 Updated development dependencies and rebuilt docs

## [9.1.0] - 2022-02-11

- 🐞/📦 `BatchProcess` exposes a promise for the completion of the startup task,
  which `BatchCluster` now uses to immediately run `#onIdle` and pop off any
  pending work.

- 📦 Updated development dependencies and rebuild docs

## [9.0.1] - 2022-01-24

- 📦 Don't emit `taskResolved` on startup tasks.

## [9.0.0] - 2022-01-23

- 💔 The `BatchProcessObserver` signature was deleted, as `BatchClusterEmitter` is
  now typesafe. Consumers should not have used this signature directly, but in
  case anyone did, I bumped the major version.

- ✨ Added `BatchCluster.off` to unregister event listeners provided to `BatchCluster.on`.

- 📦 Private fields and methods now use [the `#` private
  prefix](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Classes/Private_class_fields)
  rather than the TypeScript `private` modifier.

- 📦 Minor tweaks (fixed several jsdoc errors, simplified some boolean logic,
  small reduction in promise chains, ...)

- 📦 Updated development dependencies and rebuild docs

## [8.1.0] - 2022-01-19

- 📦 Added `BatchCluster.procCount` and `BatchCluster.setMaxProcs`, and new
  `BatchCluster.ChildEndCountType` which includes a new `tooMany` value, which
  is incremented when `setMaxProcs` is set to a smaller value.

- 📦 Updated development dependencies

## [8.0.1] - 2021-12-21

- 🐞/📦 BatchProcess now end on spurious stderr/stdout, and reject tasks if ending.

- 📦 Relaxed default for `streamFlushMillis` to deflake CI

## [8.0.0] - 2021-12-21

- 💔/📦 RegExp pass/fail strings are escaped (which could conceivably be a breaking change, hence the major version bump)

- 📦 Refactored stdout/stderr merging code and added more tests

- 📦 Added new "taskResolved" event

- 📦 Rebuild docs

- 📦 Updated development dependencies

## [7.2.1] - 2021-09-23

- 📦 Relax typing for optional `BatchProcessOptions` fields

## [7.2.0] - 2021-09-23

- 📦 Upgrade all dev dependencies. Pulling in new TypeScript 4.4 required [redoing all node imports](https://github.com/microsoft/TypeScript/issues/46027#issuecomment-926019016).

## [7.1.0] - 2021-07-14

- ✨ Added `on("healthCheckError", err, proc)` event

- 🐞 Fixed process start lag (due to startup tasks not emitting an `.onIdle`)

- 🐞 Reworked when health checks were run, and add tests to validate failing health checks recycle children

- 📦 Rebuild docs

## [7.0.0] - 2021-07-06

- 💔 Several fields were renamed to make things more consistent:
  - `BatchCluster.pendingTasks` was renamed to `BatchCluster.pendingTaskCount`.
  - A new `BatchCluster.pendingTasks` method now matches `BatchCluster.currentTasks`, which both return `Task[]`.
  - `BatchCluster.busyProcs` was renamed to `busyProcCount`.
  - `BatchCluster.spawnedProcs` was renamed to `spawnedProcCount`.

- ✨ Added support for "health checks" that run periodically on child processes.
  Both `healthCheckCommand` and `healthCheckIntervalMillis` must be set to
  enable this feature.

- ✨ New `pidCheckIntervalMillis` to verify internal child process state is kept
  in sync with the process table. Defaults to every 2 minutes. Will no-op if idle.

- ✨ New `BatchCluster.childEndCounts` to report why child processes were recycled (currently "dead" | "ending" | "closed" | "worn" | "idle" | "broken" | "old" | "timeout" )

- 📦 Cleaned up scheduling: the prior implementation generated a bunch of
  `Promise`s per idle period, which was rough on the GC. Use of `Mutex` is now
  relegated to tests.

- 📦 `tsconfig` now emits `ES2018` output and doesn't have `downlevelIteration`,
  which reduces the size of the generated javascript, but requires contemporary
  versions of Node.js.

- 📦 `BatchClusterOptions` doesn't mark fields as `readonly` anymore

- 📦 `Task` has a default type of `any` now.

## [6.2.1] - 2021-07-01

- 📦 Added `BatchCluster.currentTasks`

## [6.2.0] - 2021-07-01

- 📦 Updated development dependencies, which required handling undefined process ids.

## [6.1.0] - 2021-05-03

- ✨ Added `BatchCluster.closeChildProcesses()` (ends child processes but doesn't `.end()` the BatchCluster instance)
- 📦 Updated development dependencies

## [6.0.2] - 2021-03-17

- 📦 Include sourcemaps
- 📦 Updated development dependencies

## [6.0.1] - 2021-02-16

- 📦 Updated development dependencies
- 📦 Renamed `main` branch
- 📦 Hopefully fixed all typedoc URL changes

## [6.0.0] - 2020-12-04

No new features in v6: just a breaking change so we can fix an old name
collision that caused linting errors.

- 💔 Prior versions name-collided on `Logger`: both as an `interface` and as a
  pseudonamespace for logger factories. This made `eslint` grumpy, and if anyone
  actually used this bare-bones logger, it could have caused confusion.

  `Logger` now references _only the `interface`._

  The builder functions are now named `Log`.

- 📦 Updated development dependencies

## [5.11.3] - 2020-11-20

- 📦 Updated development dependencies (primarily TypeScript 4.1)
- 📦 `Deferred.resolve` now requires an argument (as per the new Promise spec).
  As this is just a typing change (and `Deferred` is an internal
  implementation), I'm not bumping the major version.

## [5.11.2] - 2020-08-25

- 📦 Updated development dependencies
- 📦 Minor delint/prettier reformat

## [5.11.1] - 2020-07-14

- 📦 Updated development dependencies

## [5.11.0] - 2020-07-01

- ✨ `BatchCluster` can now be created with a `Logger` thunk.
- 📦 De-linted
- 📦 Updated development dependencies
- 📦 Add Node v14 to build matrix

## [5.10.0] - 2020-04-11

- ✨ New `maxIdleMsPerProcess` option: automatically shut down idle child
  processes to reduce system resource consumption. Defaults to `0`, which
  disables this feature (and prevents me from having to increment the major
  version!)
- 📦 Updated development dependencies

## [5.9.5] - 2020-03-30

- 📦 Updated development dependencies
- 📦 Ran prettier (2.0.0 causes many no-op diffs due to changed defaults)

## [5.9.4] - 2020-03-15

- 📦 Updated development dependencies

## [5.9.3] - 2020-02-11

- 🐞 `BatchProcess`'s streams could cause an infinite loop on `.end()` when
  `stdout` was destroyed.
- 📦 Updated development dependencies

## [5.9.2] - 2020-01-26

- 🐞 `BatchProcess.ready` now verifies the child process still exists
- 📦 Replace tslint with eslint
- 📦 Updated development dependencies

## [5.9.1] - 2019-12-06

- 🐞 Errors after a process has shut down are logged and not propagated
- 📦 Updated development dependencies

## [5.9.0] - 2019-11-21

- 🐞 Moved all async throws into observables (to prevent "This error originated
  either by throwing inside of an async function without a catch block, or by
  rejecting a promise which was not handled with .catch(). The promise rejected
  with the reason...")
- 📦 Updated development dependencies

## [5.8.0] - 2019-11-14

- 🐞 Fixed issue where immediately closing a process before a pending task
  completed resulted in `Error: onExit(exit) called end()`
- 📦 Updated development dependencies

## [5.7.1] - 2019-10-24

- 📦 `BatchCluster.end()` should return a `Deferred<void>`

## [5.7.0] - 2019-10-24

- 🐞 Fixed issue where `onStartError` and `onTaskError` didn't get emitted.
- 📦 Updated development dependencies, rebuilt docs.
- 🐞 Deflaked CI tests with longer timeouts and less aggressive `shutdown()`
- 📦 Had to delete the macOS Travis tests. Travis has been terribly flaky, with
  unreproduceable spec failures.

## [5.6.8] - 2019-09-01

- 📦 Updated development dependencies (new TypeScript)

## [5.6.7] - 2019-07-15

- 📦 Updated development dependencies

## [5.6.6] - 2019-06-25

- 📦 Updated development dependencies

## [5.6.5] - 2019-05-18

- 📦 wrapped `stdin.write()` with try/catch that rejects the current task and
  closes the current process.
- 📦 wrapped `stdin.end()` with try/catch (as `.writable` isn't reliable)

## [5.6.4] - 2019-05-18

- 📦 Updated development dependencies

## [5.6.3] - 2019-04-03

- 📦 Moved to the PhotoStructure org. Updated URLs in docs.

## [5.6.2] - 2019-03-27

- 📦 Updated development dependencies
- 📦 Removed trace and debug log calls in `BatchProcess` (which incurred GC
  overhead even when disabled)

## [5.6.1] - 2019-03-16

- 📦 Expose `BatchCluster.options`. Note that the object is frozen at
  construction.

## [5.6.0] - 2019-03-15

- 🐞/✨ `BatchProcess.end()` didn't correctly implement `gracefully` (which
  resulted in spurious `end(): called while not idle` errors), and allowed for
  multiple calls to destroy and disconnect from the child process, which may or
  may not have been ill-advised.

## [5.5.0] - 2019-03-14

- ✨ Added `BatchCluster.isIdle`. Updated development dependencies. Deflaked CI by embiggening
- ✨ Added `BatchClusterOptions.cleanupChildProcs`, in case you want to handle
  process cleanup yourself.
- 📦 Updated development dependencies. Deflaked CI by embiggening timeouts.
- Happy 🥧 day.

## [5.4.0] - 2019-03-13

- ✨ "wear-leveling" for processes. Previously, only the first-spawned child
  process would service most task requests, but that caused issues with (very)
  long-running tasks where the other child processes would be spooled off ram,
  and could time out when requested later.
- 🐞 `maxProcs` is respected again. In prior builds, if tasks were enqueued all
  at once, prior dispatch code would only spin 1 concurrent task at a time.
- 🐞 Multiple calls to `BatchProcess.end` would result in different promise
  resolution targets: the second call to `.end()` would resolve before the
  first. This was fixed.
- ✨
  [BatchProcessOptions](https://batch-cluster.js.org/classes/batchclusteroptions.html)'s
  `minDelayBetweenSpawnMillis` was added, to help relieve undue system load on
  startup. It defaults to 1.5 seconds and can be disabled by setting it to 0.

## [5.3.1] - 2019-03-05

- 📦 Removed `Deferred`'s warn log messages.

## [5.3.0] - 2019-03-05

- 🐞 `.pass` and `.fail` regex now support multiple line outputs per task.

## [5.2.0] - 2019-03-04

- 🐞 [BatchProcessOptions](https://batch-cluster.js.org/classes/batchclusteroptions.html)`.pass`
  and `.fail` had poorly specified and implemented failure semantics. Prior
  implementations would capture a "failed" string, but not tell the task that
  the service returned a failure status.

  Task [Parser](https://batch-cluster.js.org/interfaces/parser.html)s already
  accept stdout and stderr, and are the "final word" in resolving or rejecting
  [Task](https://batch-cluster.js.org/classes/task.html)s.

  `v5.2.0` provides a boolean to Parser's callable indicating if the wrapped
  service returned pass or fail, and the Parser may return a Promise now, as
  well.

  There's a new `SimpleParser` implementation you can use that fails if `stderr`
  is non-blank or a stream matched the `.fail` pattern.

- 🐞 initial `BatchProcess` validation uses the new `SimpleParser` to verify the
  initial `versionCommand`.

- ✨ child process pids are delivered to event listeners on spawn and close. See
  [BatchClusterEmitter](https://batch-cluster.js.org/classes/batchclusteremitter.html).

- 🐞 fix "Error: end() called when not idle" by debouncing stdout and stderr
  readers. Note that this adds latency to every task. See
  [BatchProcessOptions](https://batch-cluster.js.org/classes/batchclusteroptions.html)'s
  `streamFlushMillis` option, which defaults to 10 milliseconds.

- 🐞 RegExp for pass and fail tokens handle newline edge cases now.

- 📦 re-added tslint and delinted code.

## [5.1.0] - 2019-03-02

- ✨ `ChildProcessFactory` supports thunks that return either a `ChildProcess` or
  `Promise<ChildProcess>`
- 📦 Update deps

## [5.0.1] - 2018-11-29

- 📦 Update deps
- 📦 re-run prettier

## [5.0.0] - 2018-10-26

- 💔 The `rejectTaskOnStderr` API, which was added in v4.1.0 and applied to all
  tasks for a given `BatchCluster` instance, proved to be a poor decision, and
  has been removed. The `Parser` API, which is task-specific, now receives
  **both** stdin and stderr streams. Parsers then have the necessary context to
  decide what to do on a per task or per task-type basis.
- 🐞 In previous versions, batch processes were recycled if any task had any
  type of error. This version allows pids to live even if they emit data to
  stderr.

## [4.3.0] - 2018-09-14

- ✨ If your tasks return interim progress and you want to capture that data
  as it happens, BatchCluster now emits `taskData` events with the data and the
  current task (which may be undefined) as soon as the stream data is emitted.
- 📦 Pulled in latest dependency versions

## [4.2.0] - 2018-08-18

- 📦 In the interests of less noise, the default logger is now the `NoLogger`.
  Consumers may use the `ConsoleLogger` or another `Logger` implementation as
  they see fit.

## [4.1.0] - 2018-08-17

- ✨ Support for demoting task errors from `stderr` emissions:
  `BatchProcess.rejectTaskOnStderr` is a per-task, per-error predicate which
  allows for a given error to be handled without always rejecting the task. This
  can be handy if the script you're wrapping (like ExifTool) writes non-fatal
  warnings to stderr.
- ✨ `BatchProcessOptions.pass` and `BatchProcessOptions.fail` can be RegExp
  instances now, if you have more exotic parsing needs.

## [4.0.0] - 2018-08-15

- 💔 Using Node 8+ to determine if a process is running with `kill(pid, 0)`
  turns out to be unreliable (as it returns true even after the process exits).
  I tried to pull in the best-maintained "process-exists" external dependency,
  but that pulled in 15 more modules (this used to be a zero-deps module), and
  it was extremely unperformant on Windows.

  The TL;DR: is that `running(pid)` now returns a `Promise<boolean>`, which had
  far-reaching signature changes to accomodate the new asynchronicity, hence the
  major version bump.

- 💔 In an effort to reduce this library's complexity, I'm removing retry
  functionality. All parameters associated to retries are now gone.

- ✨ Internal state validation is now exposed by BatchCluster, and is used by
  tests to ensure no internal errors happen during integration tests. Previously
  these errors were simply logged.

## [3.2.0] - 2018-06-17

- 📦 New `Logger` methods, `withLevels`, `withTimestamps`, and `filterLevels`
  were shoved into a new `Logger` namespace.

## [3.1.0] - 2018-06-17

- ✨ Added simple timestamp and levels logger prefixer for tests
- 🐞 Errors rethrown via BatchProcess now strip extraneous `Error:` prefixes
- 🐞 For a couple internal errors (versionCommend startup errors and internal
  state inconsistencies on `onExit` that aren't fatal), we now log `.error`
  rather than throw Error() or ignore.

## [3.0.0] - 2018-06-13

- ✨/💔 **`Task` promises are only rejected with `Error` instances now.** Note
  that also means that `BatchProcessObserver` types are more strict. It could be
  argued that this isn't an API breaking change as it only makes rejection
  values more strict, but people may need to change their error handling, so I'm
  bumping the major version to highlight that. Resolves
  [#3](https://github.com/mceachen/batch-cluster.js/issues/3). Thanks for the
  issue, [Nils Knappmeier](https://github.com/nknapp)!

## [2.2.0] - 2018-06-13

- 🐞 Windows taskkill `/PID` option seemed to work downcased, but the docs say
  to use uppercase, so I've updated it.
- 📦 Upgrade all deps including TypeScript to 2.9

(v2.1.2 is the same contents, but `np` had a crashbug during publish)

## [2.1.1] - 2018-04-30

- 📦 More robust `end` for `BatchProcess`, which may prevent very long-lived
  consumers from sporadically leaking child processes on Mac and linux.
- 📦 Added Node 10 to the build matrix.

## [2.1.0] - 2018-04-22

- 📦 Introduced `Logger.trace` and moved logging related to per-task items down
  to `trace`, as heavy load and large request or response payloads could
  overwhelm loggers. If you really want to see on-the-wire requests and results,
  enable `trace` in your debugger implementation. By default, the
  `ConsoleLogger` omits log messages with this level.

## [2.0.0] - 2018-04-12

- 💔 Replaced `BatchClusterObserver` with a simple EventEmitter API on
  `BatchCluster` to be more idiomatic with node's API
- 💔 v1.11.0 added "process reuse" after errors, but that turned out to be
  problematic in recovery, so that change was reverted (and with it, the
  `maxTaskErrorsPerProcess` parameter was removed)
- ✨ `Rate` is simpler and more accurate now.

## [1.11.0] - 2018-04-11

- ✨ Added new `BatchClusterObserver` for error and lifecycle monitoring
- 📦 Added a number of additional logging calls

## [1.10.0] - 2018-03-01

- 🐞 Explicitly use `timers.setInterval`. May address [this
  issue](https://stackoverflow.com/questions/48961238/electron-setinterval-implementation-difference-between-chrome-and-node).
  Thanks for the PR, [Tim Fish](https://github.com/timfish)!

## [1.9.1] - 2018-03-01

- 📦 Changed `BatchProcess.end()` to use `until()` rather than `Promise.race`,
  and always use `kill(pid, forced)` after waiting the shutdown grace period
  to prevent child process leaks.

## [1.9.0] - 2018-02-28

- ✨ New `Logger.setLogger()` for debug, info, warning, and errors. `debug` and
  `info` defaults to Node's
  [debuglog](https://nodejs.org/api/util.html#util_util_debuglog_section),
  `warn` and `error` default to `console.warn` and `console.error`,
  respectively.
- 📦 docs generated by [typedoc](http://typedoc.org/)
- 📦 Upgraded dependencies (including TypeScript 2.7, which has more strict
  verifications)
- 📦 Removed tslint, as `tsc` provides good lint coverage now
- 📦 The code is now [prettier](https://github.com/prettier/prettier)
- 🐞 `delay` now allows
  [unref](https://nodejs.org/api/timers.html#timers_timeout_unref)ing the
  timer, which, in certain circumstances, could prevent node processes from
  exiting gracefully until their timeouts expired

## [1.8.0] - 2018-01-03

- ✨ onIdle now runs as many tasks as it can, rather than just one. This should
  provide higher throughput.
- 🐞 Removed stderr emit on race condition between onIdle and execTask. The
  error condition was already handled appropriately--no need to console.error.

## [1.7.0] - 2017-11-15

- 📦 Exported `kill()` and `running()` from `BatchProcess`

## [1.6.1] - 2017-11-14

- 📦 De-flaked some tests on mac, and added Node 8 to the build matrix.

## [1.6.0] - 2017-11-14

- ✨ Processes are forcefully shut down with `taskkill` on windows and `kill -9`
  on other unix-like platforms if they don't terminate after sending the
  `exitCommand`, closing `stdin`, and sending the proc a `SIGTERM`. Added a test
  harness to exercise.
- 📦 Upgrade to TypeScript 2.6.1
- 🐞 `mocha` tests don't require the `--exit` hack anymore 🎉

## [1.5.0] - 2017-09-15

- ✨ `.running()` works correctly for PIDs with different owners now.
- 📦 `yarn upgrade --latest`

## [1.4.2] - 2017-08-13

- 📦 Ran code through `prettier` and delinted
- 📦 Massaged test assertions to pass through slower CI systems

## [1.4.1] - 2017-06-02

- 📦 Replaced an errant `console.log` with a call to `log`.

## [1.4.0] - 2017-06-02

- 🐞 Discovered `maxProcs` wasn't always utilized by `onIdle`, which meant in
  certain circumstances, only 1 child process would be servicing pending
  requests. Added breaking tests and fixed impl.

## [1.3.0] - 2017-05-31

- 📦 Added tests to verify that the `kill(0)` calls to verify the child
  processes are still running work across different node version and OSes
- 📦 Removed unused methods in `BatchProcess` (whose API should not be accessed
  directly by consumers, so the major version remains at 1)
- 📦 Switched to yarn and upgraded dependencies

## [1.2.0] - 2017-05-27

- ✨ Added a configurable cleanup signal to ensure child processes shut down on
  `.end()`
- 📦 Moved child process management from `BatchCluster` to `BatchProcess`
- ✨ More test coverage around batch process concurrency, reuse, flaky task
  retries, and proper process shutdown

## [1.1.0] - 2017-05-09

- ✨ `BatchCluster` now has a force-shutdown `exit` handler to accompany the
  graceful-shutdown `beforeExit` handler. For reference, from the
  [Node docs](https://nodejs.org/api/process.html#process_event_beforeexit):

> The 'beforeExit' event is not emitted for conditions causing explicit
> termination, such as calling process.exit() or uncaught exceptions.

- ✨ Remove `Rate`'s time decay in the interests of simplicity

## [1.0.0] - 2017-05-04

- ✨ Integration tests now throw deterministically random errors to simulate
  flaky child procs, and ensure retries and disaster recovery work as expected.
- ✨ If the `processFactory` or `versionCommand` fails more often than a given
  rate, `BatchCluster` will shut down and raise exceptions to subsequent
  `enqueueTask` callers, rather than try forever to spin up processes that are
  most likely misconfigured.
- ✨ Given the proliferation of construction options, those options are now
  sanity-checked at construction time, and an error will be raised whose message
  contains all incorrect option values.

## [0.0.2] - 2017-05-03

- ✨ Added support and explicit tests for
  [CR LF, CR, and LF](https://en.wikipedia.org/wiki/Newline) encoded streams
  from spawned processes
- ✨ child processes are ended after `maxProcAgeMillis`, and restarted as needed
- 🐞 `BatchCluster` now practices good listener hygene for `process.beforeExit`

## [0.0.1] - 2017-05-02

- ✨ Extracted implementation and tests from
  [exiftool-vendored](https://github.com/mceachen/exiftool-vendored.js)

[19.5.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.5.0
[19.4.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.4.1
[19.4.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.4.0
[19.3.2]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.3.2
[19.3.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.3.0
[19.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.2.0
[19.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.1.0
[19.0.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.0.1
[19.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v19.0.0
[18.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v18.0.0
[17.3.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v17.3.1
[17.3.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v17.3.0
[17.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v17.2.0
[17.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v17.1.0
[17.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v17.0.0
[16.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v16.0.0
[15.0.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v15.0.1
[15.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v15.0.0
[14.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v14.0.0
[13.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v13.0.0
[12.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v12.1.0
[12.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v12.0.0
[11.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v11.0.0
[10.4.3]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.4.3
[10.4.2]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.4.2
[10.4.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.4.1
[10.4.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.4.0
[10.3.2]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.3.2
[10.3.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.3.1
[10.3.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.3.0
[10.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.2.0
[10.1.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.1.1
[10.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.1.0
[10.0.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.0.1
[10.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v10.0.0
[9.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v9.1.0
[9.0.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v9.0.1
[9.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v9.0.0
[8.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v8.1.0
[8.0.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v8.0.1
[8.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v8.0.0
[7.2.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v7.2.1
[7.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v7.2.0
[7.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v7.1.0
[7.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v7.0.0
[6.2.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v6.2.1
[6.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v6.2.0
[6.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v6.1.0
[6.0.2]: https://github.com/photostructure/batch-cluster.js/releases/tag/v6.0.2
[6.0.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v6.0.1
[6.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v6.0.0
[5.11.3]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.11.3
[5.11.2]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.11.2
[5.11.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.11.1
[5.11.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.11.0
[5.10.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.10.0
[5.9.5]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.9.5
[5.9.4]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.9.4
[5.9.3]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.9.3
[5.9.2]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.9.2
[5.9.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.9.1
[5.9.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.9.0
[5.8.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.8.0
[5.7.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.7.1
[5.7.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.7.0
[5.6.8]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.8
[5.6.7]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.7
[5.6.6]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.6
[5.6.5]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.5
[5.6.4]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.4
[5.6.3]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.3
[5.6.2]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.2
[5.6.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.1
[5.6.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.6.0
[5.5.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.5.0
[5.4.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.4.0
[5.3.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.3.1
[5.3.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.3.0
[5.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.2.0
[5.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.1.0
[5.0.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.0.1
[5.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v5.0.0
[4.3.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v4.3.0
[4.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v4.2.0
[4.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v4.1.0
[4.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v4.0.0
[3.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v3.2.0
[3.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v3.1.0
[3.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v3.0.0
[2.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v2.2.0
[2.1.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v2.1.1
[2.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v2.1.0
[2.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v2.0.0
[1.11.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.11.0
[1.10.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.10.0
[1.9.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.9.1
[1.9.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.9.0
[1.8.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.8.0
[1.7.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.7.0
[1.6.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.6.1
[1.6.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.6.0
[1.5.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.5.0
[1.4.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.4.1
[1.4.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.4.0
[1.3.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.3.0
[1.2.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.2.0
[1.1.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.1.0
[1.0.0]: https://github.com/photostructure/batch-cluster.js/releases/tag/v1.0.0
[0.0.2]: https://github.com/photostructure/batch-cluster.js/releases/tag/v0.0.2
[0.0.1]: https://github.com/photostructure/batch-cluster.js/releases/tag/v0.0.1
