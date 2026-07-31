# Child and task lifecycle: invariants and landmines

Completed 2026-07-29. The user-facing list of changes is in [CHANGELOG.md](../../CHANGELOG.md)
under v19.0.0; this file is only what the next person needs in order to change this code without
reintroducing what took five review rounds to find.

The work started as "stop leaking child processes" and ended up covering promises too, because they
are the same bug: something the library owns gets dropped, and nothing reports it.

## Invariants

Break any of these and the failure is silent — a stranded process, or an `await` that never returns.

### 1. `#procs` answers "who can run a task?"; `#unexitedProcs` answers "who must I kill?"

`ProcessPoolManager#procs` is the schedulable pool. A process leaves it the instant we decide to
recycle it, which is often **seconds** before it dies. Anything asking "what might still be
running?" — above all `BatchCluster#exitListener` — must read `unexitedPids()` instead.

`unexitedPids()` is populated in `#adoptChild()` the moment `processFactory()` resolves (before the
`BatchProcess` is constructed, so an adoption failure is still covered), and drained on the child's
`"exit"` event.

### 2. Explicit `end()` is a true barrier; automatic exit cleanup is bounded

When explicit `BatchCluster.end()` resolves, nothing it spawned is still running and nothing the
caller awaits is left dangling. `BatchCluster` drops the synchronous `exit` backstop as soon as
`end()` resolves, and callers `process.exit()` immediately after, so "resolved" has to mean
"finished". The internal bounded form used by `beforeExit` is best effort for factories that have
not returned.

Five ordering constraints, each of which was a bug at some point:

- **Explicit `BatchCluster.end()` has no deadline.** An opaque async factory may already own a child
  that BatchCluster cannot see; returning before it settles makes `await end(); process.exit(0)`
  capable of orphaning that child. A factory that never settles therefore keeps explicit shutdown
  pending.
- **Automatic `beforeExit` cleanup is bounded.** It passes `spawnTimeoutMillis` as an internal
  deadline because process exit cannot wait forever for an opaque factory. The deadline is taken
  before the first drain so it covers pooled children that consume the full graceful window.
- **`closeChildProcesses()` is called before any `await`, but not awaited there.** It clears
  `#procs` synchronously — the test _"pids() returns [] immediately after end()"_ pins that
  observable — while the bounded loop is what actually waits, via `#terminating`.
- **Waiting covers in-flight spawns and in-flight terminations, not just `#procs`.** A
  `processFactory()` can spawn its child and only _resolve_ later (validation, path lookup); a
  recycling process is already out of `#procs`. Hence `#spawning` and `#terminating`.
- **At the automatic-cleanup deadline, `end()` does not simply give up.** It force-kills everything
  still known to be alive _and_ settles tasks still waiting inside those terminations
  (`BatchProcess.abandonTerminatingTask()`), because `ProcessTerminator` gives a running task up to
  2s to finish — longer than a bounded shutdown may wait.

### 3. Cleanup runs _before_ calling anything the consumer supplied

`logger()`, `emit("childEnd")`, `emit("endError")` are all consumer code that can throw. Every site
that kills or settles does so first and notifies second. This was two separate bugs: a throwing
`warn()` skipped `ProcessTerminator`'s force-kill entirely, and a throwing `childEnd` listener made
a tracked termination report success with the child still alive.

### 4. `cleanupChildProcs: false` suppresses _every_ kill

The option means "I have another means of PID cleanup." Last-resort kills are exactly where it is
tempting to ignore it. Route them through `#forceKill`/`#forceKillAll`, which honor it and log the
pid instead so an opted-out caller can find the child.

### 5. Outstanding work keeps the event loop alive; idle clusters do not

Everything else this library owns is deliberately unref'd (child procs, their streams, the idle
interval, the respawn timer) so an idle cluster never stops a script from exiting — that is the
`unrefStreams` contract. But unsettled _work_ had nothing holding the loop open either, so node
would drain, `beforeExit` would fire, and `end()` would tear down a task the caller was awaiting.
`BatchCluster#updateKeepAlive()` holds one ref'd interval while `!isIdle`.

Note the only thing that used to prevent this was the per-task timeout timer, which does not exist
at the default `taskTimeoutMillis: 0`.

### 6. Every task must settle

A queued task has no owning process, so nothing else will ever settle it: `ProcessTerminator` only
rejects the task a process was actually running. `end()` calls
`TaskQueueManager.rejectPendingTasks()`. An abandoned promise is the worst possible outcome — the
caller's `await` hangs and node can still exit 0 with no error at all.

### 7. `"disconnect"` is not `"exit"`

It only means an IPC channel closed. Resolving the exit deferred there makes `running()` false,
which skips both the SIGTERM and the SIGKILL in `ProcessTerminator`. Only `"exit"` and `"close"` are
authoritative.

## Landmines in the production code

- **Published API with pinned semantics**: `pids()`, `procCount`, and `stats()` must keep their
  current meaning and must keep emptying promptly. The `shutdown()` helper in `BatchCluster.spec.ts`
  and four `expect(stats()).to.eql({...})` deep-equals depend on it; so does exiftool-vendored,
  whose `[Symbol.dispose]` calls `closeChildProcesses(false)` _after_ `end(true)` — that method must
  stay non-terminal and must not throw post-`end()`.
- `spawnedProcCount` counts spawn _attempts_, incremented before the factory call. Don't move it.
- `ProcessPoolManager` is not exported from the package, so its signature is free. `BatchProcess`'s
  constructor **is** exported: making it private is a semver-major type break, which is why
  ownership fixes live in the pool rather than in a static factory.
- `Pids.kill()` returns false for both `ESRCH` and `EPERM` rather than throwing: callers signal
  lists of pids in loops, and one throw stranded every pid after it.
- `killGroup()` falls back to signalling the pid when the group signal fails. `-pid` names a group
  only if the child leads one; for a non-detached child the OS says `ESRCH`, and a silent no-op
  there would leak the child. It cannot signal the parent's group by accident — that group is named
  by its own leader's pid, which is alive and so can never be reassigned to a child.
- After a detached leader exits, `ProcessTerminator` uses `killGroupOnly()` to clean up surviving
  grandchildren without falling back to the dead leader's pid. Falling back there could hit an
  unrelated process if the OS had already reused the pid.
- `thenOrTimeout()` treats a timeout `<= 1` as _disabled_. Passing it a nearly-expired remaining-ms
  turns a bounded wait into an unbounded one.
- `ProcessTerminator` destroys the child's streams _before_ the graceful wait, so anything the child
  writes during shutdown may hit a closed pipe.

## Landmines in the tests

Most of the time lost on this work went here, not to the production code.

- **Mocha's per-test timeout timer is ref'd**, so it holds the event loop open and completely masks
  event-loop-lifetime defects. Anything about "does node exit too early" needs a subprocess helper
  (`pending-task-helper.ts`, `exit-backstop-helper.ts`, `exit-backstop-vacuum-helper.ts`).
- **The subprocess deadline belongs in the parent** (`runSpecHelper()`), never inside the helper: an
  in-helper watchdog would itself be ref'd and mask what the helper exists to test.
- **`test.js` with `IGNORE_EXIT` is not a stubborn child.** Its exit/SIGTERM handlers write to a
  stdout the terminator has already destroyed, so it dies of EPIPE early in shutdown. For a child
  that genuinely survives until SIGKILL, use `stubborn-child-helper.ts`, which answers the startup
  command, ignores SIGTERM silently, and swallows stream errors.
- **A child with no `keepalive` exits on its own** the moment termination destroys its stdin, long
  before any force-kill would matter. Run `keepalive 60000` first if the test needs it alive.
- **`spawnTimeoutMillis` also caps the startup task.** Do not shorten it to test automatic cleanup;
  pass the internal `ProcessPoolManager.end(..., maxWaitMillis)` bound after the fixture is ready.
- **`pidExists()` is true for zombies**, and `kill()` returns as soon as the signal is queued — the
  process can still read as running microseconds later. Always assert death with
  `until(() => !pidExists(pid), ms)`, never a bare `pidExists()` immediately after a kill.
- **`await bc.enqueueTask(...)` does not mean the process is idle.** `BatchProcess` clears its
  current task in a `.then` registered _after_ the caller's, so it is still `busy` when your `await`
  resumes — and `vacuumProcs()` only recycles idle procs. Wait for `isIdle`.
- **`flaky 1` is unusable as "a task that fails once".** Its first output line embeds the literal
  `FAIL` token, so the task settles on line 1 and line 2 arrives task-less, ending the process as
  `stdout.error`. Use `stderrfail`.
- **Tests that spawn children directly must reap them in `afterEach`.** A failing assertion
  otherwise leaves a SIGTERM-proof child running on the developer's machine (this happened, for 38
  minutes, during this work).
- **Confirm a new regression test actually discriminates** by reverting the fix and watching it go
  red. Three separate versions of the shutdown-deadline test passed with the fix disabled, each for
  a different reason from the list above.

## Deliberately still open

- A task wedged with `taskTimeoutMillis: 0` holds its `maxProcs` slot forever, since `vacuumProcs()`
  only inspects idle procs. Tracked, so not a leak — an unbounded capacity stall. It now also keeps
  the host process alive rather than exiting silently, which is the intended trade-off but makes
  setting `taskTimeoutMillis` more important than it was.
- A `processFactory` that rejects _after_ spawning, without killing its child, still leaks it. That
  is `ChildProcessFactory`'s documented contract; the test _"leaky factory leaves orphaned process"_
  exists to document it.
- Automatic `beforeExit` cleanup cannot guarantee cleanup of a child hidden forever inside an
  opaque factory. The explicit `end()` barrier is the supported guarantee; automatic cleanup is
  bounded best effort.
- `killProcessGroup` has no known consumer. Reverting it is self-contained: `killGroup`/`killerFor`
  in `src/Pids.ts`, the option, and the three call sites that select between them.
- Windows and macOS behavior for all of the above is CI-verified only; every repro and manual run
  during this work was Linux.
