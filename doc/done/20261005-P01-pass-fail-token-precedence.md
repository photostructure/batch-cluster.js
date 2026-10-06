# TPP: Let the earlier of the pass and fail tokens decide a task

## Status

**Current phase**: Complete (2026-10-05). All tasks are done and committed.

Next: none. Release v19.5.0 through **Build & Prepare Release** (see `RELEASE.md`) with `minor`.

Before this work, two commits sat on top of `Release 19.4.1`, already on `origin/main`:

- `a93c7d5 fix(StreamHandler): route each chunk's lines to their task in one call`
- `560d04e fix(StreamHandler): decode output across chunk boundaries`

`a93c7d5` extended the defect this TPP fixes to line mode (`isRetirementRequest`);
without line buffering, the defect predates v19.4.1. Do not release until Task 2 lands.

All commands below assume:

```bash
export PROJECT_ROOT="$(git rev-parse --show-toplevel)"
```

## Goal Definition

- **Bug**: when one `Task.onStdout()` call contains both the fail token and the pass token, the
  task passes even if the fail token came first, so a task's result depends on how its output was
  split into calls.
- **Why it matters**: since `a93c7d5`, line mode (`isRetirementRequest` set) delivers all complete
  lines of a chunk in one call. A task printing `FAIL\nPASS\n` now passes when both lines arrive in
  one chunk and fails when they arrive in two. Before `a93c7d5`, line mode failed it either way,
  and `BatchProcessOptions.isRetirementRequest` documents line buffering as independent of chunk
  boundaries.
- **Fix approach**: in `Task.onStdout()`, when both regexes match, the match with the smaller
  position decides. On a tie, pass wins, so configurations where pass and fail are the same token
  (exiftool-vendored uses `{ready}` for both) behave as today. The first stdout decision persists
  across later calls; stderr failure tokens can still override it before parsing. Use `search()`
  and a fresh regex for token removal so shared matcher state cannot leak to other streams/tasks.
- **Reproducing tests**: Task 1 (failed before the fix, now pass).
- **Key constraint**: do not undo the batching in `StreamHandler`: per-line delivery makes
  `Task.onStdout()` quadratic (measurements below).

## Background: what happened, with measurements

### 1. Quadratic line mode (fixed in `a93c7d5`)

With `isRetirementRequest` set, `StreamHandler` used to call `task.onStdout(line)` once per line.
Before this fix, `Task.onStdout()` appended to `#stdout` and tried `passRE.exec()`, then
`failRE.exec()` if pass did not match, over the whole buffer on every call. Measurements on this
machine used a child printing N short lines, then `PASS`:

| Output              | Chunked (no `isRetirementRequest`) | Line mode before `a93c7d5` | Line mode after |
| ------------------- | ---------------------------------- | -------------------------- | --------------- |
| 25k lines, 264 KB   | 7 ms                               | 1,527 ms                   | —               |
| 100k lines, 1.1 MB  | 34 ms                              | 30,025 ms                  | 55 ms           |
| 1.6M lines, 19.7 MB | 2,802 ms                           | not run                    | 2,867 ms        |

ExifTool's `-listx` (559,612 lines, 18.4 MB, per the original report from exiftool-vendored)
exceeded an 8 s task timeout in line mode before the fix.

`a93c7d5` added `TaskOutputBatch` (`src/StreamHandler.ts:23`), used by `#consumeStdout()` and
`#consumeStderr()`: each chunk's complete lines go to their task in one call, an unterminated line
is held until its newline, and a batch is cut early only if the owning task changes mid-chunk.

### 2. UTF-8 corruption (fixed in `560d04e`)

Without line buffering, `StreamHandler` passed raw `Buffer` chunks to the task, and
`Task.onStdout()` called `buf.toString()` per chunk, so a multi-byte character split across chunks
became `�` (`-listx` output contained `Кана��ов` where ExifTool printed `Каналов`). Now
`StreamHandler` decodes every chunk with its per-stream `StringDecoder`, flushes the decoder at end
of stream, and `#routeStdout()`/`#routeStderr()` accept only `string`. Tasks, `taskData`, and
`noTaskData` receive strings, never `Buffer`s.

### 3. The precedence defect (this TPP)

Before this fix, `Task.onStdout()` checked `passRE` first and only checked `failRE` if pass did not match.
Per-line delivery hid that, because a `FAIL` line always settled the task before a later `PASS`
line arrived. Batching exposed it. Probe results (`pass: "PASS"`, `fail: "FAIL"`,
`streamFlushMillis: 0`):

| Mode, how `FAIL\nPASS\n` arrives | Before `a93c7d5` | After `a93c7d5`, before this fix |
| -------------------------------- | ---------------- | -------------------------------- |
| Line mode, one chunk             | `passed: false`  | **`passed: true`**               |
| Line mode, two chunks            | `passed: false`  | `passed: false`                  |
| No line mode, one chunk          | `passed: true`   | `passed: true`                   |
| No line mode, two chunks         | `passed: false`  | `passed: false`                  |

The same rule made `pass: "OK"`, `fail: "NOT OK"` pass on the output `NOT OK` before this fix,
because `OK` was checked first. Without line buffering, this chunk dependence predates v19.4.1.

## Approaches considered

### For the quadratic scan (settled: batching, `a93c7d5`)

| Approach                                                                                   | Outcome     | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Batch a chunk's complete lines into one `onStdout()`/`onStderr()` call (`TaskOutputBatch`) | **Adopted** | ~15 lines in `StreamHandler`, works for string and `RegExp` tokens alike. Exposed the precedence defect.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Scan only new data plus an overlap in `Task`                                               | Rejected    | Exact only for literal string tokens. A user `RegExp` can depend on any earlier text (`/^PASS/` without `m` matches only at the start of all stdout; lookbehinds), so it needs a full-rescan fallback, and those users keep the quadratic line mode. Needs new `TaskOptions` fields. A naive version that slices the growing string measured 2,247 ms, no faster than today: V8 flattens the `+=` cons-string on every `slice`/`exec`. Keeping pieces in an array measured 20 ms. Possible later optimization for string tokens only. |
| Defer the scan to a microtask in `Task`                                                    | Rejected    | Breaks the `src/Task.spec.ts` test "retains a failure discovered by beforeParse (0 ms)": that v19.2.0 fix needs the pre-parse flush to record a `FAIL` token synchronously, before the parser runs.                                                                                                                                                                                                                                                                                                                                   |

### For UTF-8 decoding (settled: `StreamHandler`, `560d04e`)

| Approach                                     | Outcome     | Why                                                                                                                                                                                                                                        |
| -------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Decode once per stream in `StreamHandler`    | **Adopted** | One decoder per stream for both modes. No `Task` subclass or listener can see a split `Buffer` again.                                                                                                                                      |
| Decode in `Task`                             | Rejected    | Subclasses that convert the `Buffer` themselves stay broken: exiftool-vendored's `ExifToolTask.onStderr()` calls `buf.toString()` before `super.onStderr()`. `taskData` listeners would still get split `Buffer`s.                         |
| `setEncoding("utf8")` on the child's streams | Rejected    | Changes the data type for every other `"data"` listener on a `ChildProcess` the consumer owns. Must stay off in line mode, whose ownership tracking needs to see bytes held back mid-character, so it would leave two decoding mechanisms. |

### For token precedence (adopted: this TPP)

| Approach                                                                                            | Outcome     | Why                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Earlier match wins in `Task.onStdout()`, ties go to pass**                                    | **Adopted** | Selects among tokens matching at the first stdout completion. The Task 1 literal-token cases give the same result across chunk splits in both modes. Other pairs can depend on chunking if one pattern matches before an earlier-starting pattern is complete: without line buffering, pass `OK` can finish before fail `NOT OK!`; with line buffering, patterns spanning lines or looking ahead past a line can do the same. |
| (i) `StreamHandler` sends any line that matches `passRE`/`failRE` on its own immediately, by itself | Rejected    | Works around the `Task` bug in line mode only. Couples `StreamHandler` to the pass/fail regexes (two new `StreamHandlerOptions` fields from `BatchProcess`). Testing each line with `exec()` would move a shared `/g` regex's `lastIndex`, so it would need `String.prototype.search()`.                                                                                                                                      |
| Revert to per-line routing                                                                          | Rejected    | Restores the quadratic line mode (30 s for 100k lines).                                                                                                                                                                                                                                                                                                                                                                       |
| Leave it and document the chunk dependence                                                          | Rejected    | Contradicts the line-mode documentation and makes task results depend on pipe timing.                                                                                                                                                                                                                                                                                                                                         |

## Context Research

### The original code

`Task.onStdout()` before this fix:

```typescript
onStdout(buf: string | Buffer): void {
  this.#stdout += buf.toString();
  const passRE = this.#opts?.passRE;
  if (passRE != null && passRE.exec(this.#stdout) != null) {
    // remove the pass token from stdout:
    this.#stdout = this.#stdout.replace(passRE, "");
    void this.#resolve(true);
  } else {
    const failRE = this.#opts?.failRE;
    if (failRE != null && failRE.exec(this.#stdout) != null) {
      // remove the fail token from stdout:
      this.#stdout = this.#stdout.replace(failRE, "");
      void this.#resolve(false);
    }
  }
}
```

`Task.onStderr()` checks only `failRE`, so it has no precedence question. Leave
it alone.

### Landmines

- **`streamFlushMillis: 0` runs the parser inside `onStdout()`.** `#resolve()` only awaits when
  `streamFlushMillis > 0`, so `beforeParse` (which flushes `StreamHandler`'s held fragments) and the
  parser run synchronously in the `onStdout()` call that found the token. The
  `src/Task.spec.ts` tests "retains a failure discovered by beforeParse" depend on this. Do not add an `await` before `#beforeParse`.
- **Shared `RegExp` objects carry `lastIndex`.** `passRE`/`failRE` are the consumer's objects (or
  built by `toRe()` in `src/OptionsVerifier.ts`). A losing `/g` probe left its match-end position
  behind in the first implementation, so the next task could miss its token or beforeParse could
  miss a stderr failure. Stdout now uses `search()`, which preserves matcher state. Removal uses
  a fresh regex: replacing with the shared `/y` matcher would advance its state and break the
  next task's stderr detection. `onStderr()` retains its existing matching behavior.
- **Pass and fail can be the same regex.** exiftool-vendored sets both to `"{ready}"`
  (`DefaultExifToolOptions.ts:63-64` in that repo). Both matches then have the same `index`; the tie
  must go to pass, or every exiftool-vendored task fails.
- **Token removal** uses a fresh copy of the winning regex. Non-global regexes remove one match;
  global regexes remove all matches of that pattern in the matched stdout buffer, as before.
- **More tasks may fail after this fix.** A worker that prints text containing the fail token
  before the pass token now fails consistently instead of depending on chunking. Failed tasks count
  toward `maxFailedTasksPerProcess` and trigger a health check when `healthCheckCommand` is set.
- **Test-child output containing tokens.** `src/test.js` "flaky" prints `flaky response (PASS, …)`
  or `(FAIL, …)` followed by the same token, so its result doesn't change. Re-check if new test
  commands print both words:
  ```bash
  grep -rn -i '"\(upcase\|downcase\|flaky\|stderr\)[^"]*\(pass\|fail\)' "$PROJECT_ROOT"/src/*.spec.ts
  ```
- **Mocha `beforeEach` inside a `for` loop** registers every iteration's hook on the enclosing
  `describe`, so all of them run before every test and the last one's assignments win.
  Wrap per-case hooks in their own `describe`.
- **Cross-pipe ordering in integration tests.** A stderr test whose completion token is on stdout
  races the two pipes. The `lines … stderr` and `split-utf8 stderr` test commands end with `FAIL` on
  stderr for that reason.

### Process lifecycle considerations

None directly: the change only decides `passed` for a task that already settles. See the
`maxFailedTasksPerProcess` note above.

## Tasks

### Don't blindly follow this section!

These tasks were the best plan as of 2026-10-05. If research shows a simpler path that follows
[SIMPLE-DESIGN.md](../SIMPLE-DESIGN.md), stop and present the options to the user.

### Task 1: Failing tests for token precedence

**Success**: the new tests fail before the fix for the reason below, then pass after it.

**Implementation**:

1. In `src/Task.spec.ts`, add one test per case. Each calls `task.onStdout()` once with the whole
   output and checks the `passed` argument the parser receives (see the `mkOpts` helper at the top
   of the file):

   | `passRE` / `failRE` | Output         | Expected `passed` | Before this fix                  |
   | ------------------- | -------------- | ----------------- | -------------------------------- |
   | `/PASS/` / `/FAIL/` | `FAIL\nPASS\n` | `false`           | `true` (fails)                   |
   | `/PASS/` / `/FAIL/` | `PASS\nFAIL\n` | `true`            | `true` (guard)                   |
   | `/\{ready\}/` twice | `x\n{ready}\n` | `true`            | `true` (guard: tie goes to pass) |
   | `/OK/` / `/NOT OK/` | `NOT OK\n`     | `false`           | `true` (fails)                   |

2. In `src/StreamHandler.spec.ts`, inside the `isRetirementRequest` describe, add a test that sends
   `FAIL\nPASS\n` to a real `Task` (not the mock) once as one chunk and once as two, and expects
   `passed: false` both times. Model it on "recognizes retirement before parsing a completion token
   in the same chunk" in `src/StreamHandler.spec.ts`, which already drives a real `Task` through
   `processStdout()`.
3. Compile and run; confirm the failing cases fail with `passed: true`:
   ```bash
   cd "$PROJECT_ROOT" && npm run compile && npx mocha dist/Task.spec.js dist/StreamHandler.spec.js --grep "earlier"
   ```
   (Adjust `--grep` to the test names you choose.)

**What these tests validate**:

- [x] `Task` precedence for literal tokens, including the same-token tie and an overlapping pair.
- [x] Line-mode results no longer depend on chunk boundaries for this output.
- [x] Shared `/g` regexes across tasks, losing global fail probes before stderr flushing,
      and `/y` stdout completion followed by the next task's stderr failure.

Evidence: after adding the tests, `npm run compile` followed by
`node_modules/.bin/mocha dist/Task.spec.js dist/StreamHandler.spec.js --grep 'stdout token precedence|earlier stdout token'`
reported 3 passing and 3 failing. All failures were `expected true to deeply equal false`:
`FAIL` before `PASS`, overlapping `NOT OK`/`OK`, and line mode with one chunk. The pass-first,
shared same-token regex, and two-chunk guards passed. StreamContext needs `Task<unknown>`:
`Task<boolean>` is not assignable because the private Deferred makes Task invariant.

### Task 2: Let the earlier token decide in `Task.onStdout()`

**Success**: Task 1's tests pass, and `npm test` passes.

**Implementation** (sketch, `src/Task.ts`): add a `#stdoutDecided = false` field and set it before
calling `#resolve()`, so reentrant flushes cannot change the stdout decision.

```typescript
onStdout(buf: string | Buffer): void {
  this.#stdout += buf.toString();
  const passRE = this.#opts?.passRE;
  const failRE = this.#opts?.failRE;
  if (this.#stdoutDecided) return;
  const passIndex = passRE == null ? -1 : this.#stdout.search(passRE);
  const failIndex = failRE == null ? -1 : this.#stdout.search(failRE);
  const passed = passIndex >= 0 && (failIndex < 0 || passIndex <= failIndex);
  const tokenRE = passed ? passRE : failIndex >= 0 ? failRE : undefined;
  if (tokenRE != null) {
    this.#stdoutDecided = true;
    this.#stdout = this.#stdout.replace(new RegExp(tokenRE), "");
    void this.#resolve(passed);
  }
}
```

**If architecture changed**: find token matching with
`grep -rn "passRE\|failRE" "$PROJECT_ROOT"/src/*.ts | grep -v spec`. The rule belongs wherever
stdout is checked for both tokens.

**Completion checklist**:

- [x] Task 1 tests pass.
- [x] `src/Task.spec.ts` "retains a failure discovered by beforeParse" still passes (both
      `streamFlushMillis` values).
- [x] `npm test` passes (lint, compile, package check, all specs) after the review fixes.

Evidence: `npm run compile` and `node_modules/.bin/mocha dist/Task.spec.js dist/StreamHandler.spec.js`
passed all 83 tests, including every new regression and both beforeParse failure guards.
After review fixes, the Task/StreamHandler suite has 92 passing tests and the full suite has
434 passing tests. Nine additional checks cover delayed stdout decisions, shared global matchers,
global beforeParse failures, and sticky stdout matching followed by stderr in the next task.

### Task 3: Document the rule

**Success**: the `pass` and `fail` doc comments in `src/BatchProcessOptions.ts` state the rule.

**Implementation**: after "Expected text to print if a command passes/fails", add one sentence to
each: if a task's stdout contains both, the one that appears first decides; when both match at the
same position, the task passes. Check `README.md` for a pass/fail description that needs the same
sentence (`grep -n -i "pass\b\|fail\b" "$PROJECT_ROOT"/README.md`).

- [x] Both option comments document earliest-match precedence and same-position ties.
- [x] Checked `README.md`: it has no pass/fail option description to update.

The first stdout completion remains the decision while later stdout accumulates. Stderr failures
during the stream-flush delay or beforeParse still take precedence. The initial note claiming
the regressions required later stdout failures to override a pass was wrong: those guards deliver
failures on stderr. `src/Parser.ts` now documents the same decision and retained-output contract.

### Task 4: Rewrite the unreleased changelog section

**Success**: `CHANGELOG.md` has a `v19.5.0` section (not `v19.4.2`) that lists every consumer-visible
change since v19.4.1.

The user chose minor over patch on 2026-10-05: `taskData`/`noTaskData` and `Task.onStdout()`/
`onStderr()` now receive strings where they used to receive `Buffer`s, which can break JavaScript
code (`Buffer.concat(["a", Buffer.from("b")])` throws a `TypeError`). This repo's precedent: v19.4.0
shipped a behavior change as a ✨ minor; v19.0.0 went major only because its fixes changed runtime
behavior for every consumer.

Changes to list:

1. Batching (🐞): one call per chunk instead of per line, 30 s → 55 ms for 100k lines. `taskData`
   events and the task's stderr warn log cover a chunk, not a line. Output after the completion
   token in the same chunk now reaches the parser when `streamFlushMillis: 0`, and an unterminated
   fragment there is flushed before parsing (at zero delay it used to end the worker with `stdout.error`).
2. UTF-8 (🐞): split characters no longer become U+FFFD. Fix the current wording "Without
   `isRetirementRequest` (or, for stderr, `shouldIgnoreStderrLine`)": for stderr, the bug required
   that neither option be set.
3. Payload type (✨): tasks, `taskData`, and `noTaskData` always receive strings. Name the
   `Buffer.concat()` consequence.
4. Token precedence (🐞, this TPP): the earlier token decides; same-position ties pass; examples
   `FAIL\nPASS\n` and `NOT OK` with `pass: "OK"`.

Also fix the current entry's "took 30 seconds instead of 55 ms", which reads backwards.

- [x] Replaced the heading with the linked `[v19.5.0](…/releases/tag/v19.5.0)` form. The release
      commit stages only `package.json` and `package-lock.json`, so the heading on `main` is what
      ships; `63e567c` likewise added the linked v19.4.1 heading before that release existed.
- [x] Described batching, parser tails, UTF-8 decoding conditions, string payloads and
      `Buffer.concat([...])` compatibility, and token precedence.

### Task 5: End-to-end check against ExifTool

**Success**: `-listx` through the compiled `dist/` is byte-identical to the CLI output in both
modes (apart from the trailing newline left when `{ready}` is removed), and line mode takes about as
long as mode without line buffering (both measured 4.5 s on 2026-10-03, with the 507,134-line
`-listx` from `$PROJECT_ROOT/../exiftool`).

Run with `node`, after `npm run compile`, from any scratch directory:

```javascript
const { BatchCluster, Task } = require(
  process.env.PROJECT_ROOT + "/dist/BatchCluster.js",
);
const child_process = require("node:child_process");
const exiftool = process.env.PROJECT_ROOT + "/../exiftool/exiftool";
async function run(label, extra) {
  const bc = new BatchCluster({
    processFactory: () =>
      child_process.spawn("perl", [exiftool, "-stay_open", "True", "-@", "-"]),
    versionCommand: "-ver\n-execute\n",
    pass: "{ready}",
    fail: "{ready}",
    exitCommand: "-stay_open\nFalse\n",
    maxProcs: 1,
    taskTimeoutMillis: 60000,
    streamFlushMillis: 30,
    ...extra,
  });
  try {
    const t0 = Date.now();
    const out = await bc.enqueueTask(new Task("-listx\n-execute\n", (s) => s));
    console.log(label, Date.now() - t0, "ms", Buffer.byteLength(out), "bytes");
    require("node:fs").writeFileSync(label + ".txt", out);
  } finally {
    await bc.end();
  }
}
(async () => {
  await run("chunked", {});
  await run("line", { isRetirementRequest: () => false });
})();
```

Compare with `perl "$PROJECT_ROOT/../exiftool/exiftool" -listx > raw.xml` and
`head -c -1 chunked.txt | cmp - raw.xml` (same for `line.txt`).

- [x] Both modes match the CLI output byte for byte after removing the final newline.
- [x] Line mode takes about as long as mode without line buffering.

Evidence (Linux, Node v24.21.0, ExifTool 13.52, 2026-10-05): raw CLI output was
16,879,587 bytes across 507,134 lines. Both Task outputs were 16,879,588 bytes.
Mode without line buffering took 4,355 ms; line mode took 4,453 ms. Byte comparisons confirmed
both normalized outputs matched the same CLI bytes. The documented example ends each cluster
in `finally`; the example and compare commands above reproduce this check.

The baseline was captured directly with Perl: sandboxed Node `execFileSync()` reported EPERM
despite receiving CLI output. Async spawning through BatchCluster completed normally.

### Task 6: Commit

1. `fix(Task): let the earlier of the pass and fail tokens decide` — Tasks 1–3: `src/Task.ts`,
   `src/Task.spec.ts`, `src/StreamHandler.spec.ts`, `src/BatchProcessOptions.ts`, `src/Parser.ts`.
2. `docs(CHANGELOG): describe the v19.5.0 changes` — Task 4, plus this plan at its completed path.

- [x] Implementation, validation, and second-opinion review are complete.
- [x] The user approved both commits on 2026-10-05.

Final review results:

- External Codex review: no further findings.
- Claude review (`R996`): two findings, both fixed before committing. The changelog heading
  `v19.5.0 (unreleased)` would have shipped unchanged, because the release commit stages only
  `package.json` and `package-lock.json`; it now uses the linked heading. Test comments that
  were verification one-liners (`node -e …`, "before the change") now state what each test
  guards.
- Design note from that review: the `#stdoutDecided` early return in `Task.onStdout()` means a
  stdout `FAIL` arriving after a stdout `PASS` during the flush delay no longer fails the task.
  Without it, `PASS\nFAIL\n` passes in one chunk but fails in two whenever `streamFlushMillis`
  is above 0. Stderr failures still fail the task.

## Validation

- [x] `cd "$PROJECT_ROOT" && npm test` passes after the review fixes.
- [x] Task 5 end-to-end check passes on Linux. macOS and Windows were not verified for this check.
      CI runs the Mocha suite on those platforms, without the manual ExifTool check.
- [x] Moved to `doc/done/20261005-P01-pass-fail-token-precedence.md`.

Full-suite evidence: `npm_config_cache=/tmp/batch-cluster-precedence-npm-cache npm test`
passed lint, compilation, verification of 110 package entries, and all 434 specs in about
three minutes outside the sandbox after the review fixes; the initial run had 425 passing tests.
Prettier checks on the changed source/spec files and changelog, plus `git diff --check`, passed.
ExifTool was rerun against the updated dist:
both outputs still matched 16,879,587 CLI bytes plus the token's remaining newline. Mode without
line buffering took 4,382 ms and line mode took 4,398 ms. The commands above reproduce the check.

## Second-opinion review

Verdict: LAND. All 17 accepted findings are resolved; the one veto is supported by both reviewers.
No questions or source fixes remain unreviewed. Claude used `claude-opus-5-5` with `xhigh`
effort throughout; Codex also used `xhigh`.

| Batch | Files                                                                           | Completed passes | Codex CLI | Claude CLI |
| ----- | ------------------------------------------------------------------------------- | ---------------- | --------- | ---------- |
| 1     | Task.ts, Task.spec.ts, StreamHandler.spec.ts, BatchProcessOptions.ts, Parser.ts | 2                | LAND      | LAND       |
| 2     | CHANGELOG.md and this plan, lines 1–170                                         | 3                | LAND      | LAND       |
| 3     | This plan, lines 171–360                                                        | 2                | LAND      | LAND       |
| 4     | This plan, lines 361 through EOF                                                | 2                | LAND      | LAND       |

Line ranges identify the batch split used during review; the review record below was extended
as reports arrived. Reviewers checked each batch's dependencies as well as its assigned lines.

Source batch, pass 1: Codex REVISE; Claude Opus 5.5 X Hi REVISE. The author independently
confirmed the findings against the prior Task implementation or the accepted earliest-token rule.

| ID     | Scope                     | Model             | Finding                                                                   | Severity | Accept/Veto | Evidence                                                                                                                                   | Verdict |
| ------ | ------------------------- | ----------------- | ------------------------------------------------------------------------- | -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| R767-A | Task stdout probe         | Codex CLI         | Losing fail probe leaves shared lastIndex advanced                        | Medium   | Accept      | Prior Task completed the next FAIL task and beforeParse failure; the first patch missed both. Shared/global regressions now pass.          | LAND    |
| R528-A | Task stdout completion    | Claude Opus 5.5   | PASS then FAIL changes result when split during the flush delay           | High     | Accept      | One call passed, two calls failed at 30 ms; both now pass and preserve later stdout.                                                       | LAND    |
| R528-B | Shared completion regexes | Claude Opus 5.5   | Either losing global matcher can strand the next task                     | Medium   | Accept      | Both task sequences missed the next parser call before the fix; search and cloned removal resolve both.                                    | LAND    |
| R876-A | Winning sticky matcher    | Codex author read | First remedy advanced a winning /y matcher used by the next task's stderr | Medium   | Accept      | Prior Task left lastIndex 0; shared replacement left 4 and missed stderr FAIL. Cloned replacement preserves 0 and the pinning test passes. | LAND    |

Source batch, pass 2: Codex LAND; Claude Opus 5.5 X Hi LAND. Both re-read all five files, found no
new issues, and confirmed all accepted findings resolved. Codex checked 92 tests and 30 independent
scenarios; Claude also checked real child-process output ordering and shared matcher variants.

Documentation batch 2, pass 1: Codex REVISE; Claude Opus 5.5 X Hi REVISE. Pass 2:
Codex LAND; Claude REVISE with R739-D. Pass 3: both LAND, all six findings resolved,
and no new issues. Every finding was accepted after independent verification:

| ID     | Scope                  | Model           | Finding                                                                              | Severity | Accept/Veto | Evidence                                                                                                                                                                                 | Verdict |
| ------ | ---------------------- | --------------- | ------------------------------------------------------------------------------------ | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| R098-A | Plan setup             | Codex CLI       | Setup did not export PROJECT_ROOT for the Node example                               | Medium   | Accept      | In a shell with PROJECT_ROOT unset, the documented setup failed the Node require. Exporting it makes that same check pass.                                                               | LAND    |
| R098-B | Token rule             | Codex CLI       | Plan promised chunk independence for arbitrary regexes                               | Medium   | Accept      | /OK\\n/ versus /NOT OK\\nDONE\\n/ gives false for one chunk and true for two in both modes. The claim now covers the Task 1 literal-token cases and names the longer-pattern limitation. | LAND    |
| R739-A | Changelog              | Claude Opus 5.5 | Post-token output improvement omitted the zero-delay condition                       | Medium   | Accept      | v19.4.1 lost extra output and retired on a fragment at 0 ms, but preserved both at 30 ms. Current code preserves both. Changelog and Task 4 now qualify streamFlushMillis: 0.            | LAND    |
| R739-B | Git history            | Claude Opus 5.5 | Status incorrectly attributed the original Task defect to batching                   | Medium   | Accept      | v19.4.1 and HEAD have identical Task source; batching extended its existing pass-first defect to line mode. Status now distinguishes those facts.                                        | LAND    |
| R739-C | History and references | Claude Opus 5.5 | Historical descriptions and test line numbers became stale                           | Medium   | Accept      | The named beforeParse test moved from line 56 to 187; current stdout uses search and a decision latch. Historical prose now says before this fix, and test references use names.         | LAND    |
| R739-D | Token rule             | Claude Opus 5.5 | Chunking limitation omitted longer overlapping literal tokens without line buffering | Medium   | Accept      | With pass OK and fail NOT OK!, one chunk fails but a split after OK passes at 0 and 30 ms without line buffering; both fail in line mode. The limitation now includes this case.         | LAND    |

Documentation batch 3, pass 1: Codex LAND; Claude Opus 5.5 X Hi REVISE. All five
findings were independently verified and accepted:

| ID     | Scope            | Model           | Finding                                                       | Severity | Accept/Veto | Evidence                                                                                                                                                                                                                     | Verdict |
| ------ | ---------------- | --------------- | ------------------------------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| R501-A | Style note       | Claude Opus 5.5 | Style note incorrectly claimed src had no non-null assertions | Medium   | Accept      | Both HEAD and current src/Array.ts contain assertions; the updated sketch has none. Removed the stale advice.                                                                                                                | LAND    |
| R501-B | Mocha hooks      | Claude Opus 5.5 | Hook note omitted that every loop iteration's hook runs       | Medium   | Accept      | A real Mocha fixture runs hooks 1, 2, 3 before each test, so all assignments run and the last wins. Corrected the explanation.                                                                                               | LAND    |
| R501-C | ExifTool example | Claude Opus 5.5 | Example omitted the finally cleanup described by the evidence | Medium   | Accept      | Executing the actual documented JavaScript with a rejecting task left end uncalled. Adding try/finally makes the same check call end once. Byte comparison is reproducible with the documented example and compare commands. | LAND    |
| R501-D | Test references  | Claude Opus 5.5 | Task 1 described old results and a moved test as current      | Medium   | Accept      | The named StreamHandler test moved from 802 to 840, and current regressions return false. The table now says before this fix and the reference uses the test name.                                                           | LAND    |
| R501-E | CLI line count   | Claude Opus 5.5 | Task 5 CLI line count disagreed with recorded bytes           | Medium   | Accept      | wc -lc on raw.xml gives 507134 lines and 16879587 bytes. Corrected the success criterion to 507134 CLI lines.                                                                                                                | LAND    |

Documentation batch 3, pass 2: both LAND, all five findings resolved, and no new issues.
Both reviewers ran the documented ExifTool example and compared its bytes. The author also
verified rejection cleanup; Claude checked a real throwing parser and found no child left running.

Codex batch 3 startup: two invocations emitted no JSON events or reviewer handle and were
interrupted with exit 130. A fresh invocation with unrelated MCP servers and js_repl disabled
for that process completed normally. These are startup attempts, not completed review passes;
no global settings changed.

Documentation batch 4, pass 1: Codex LAND; Claude Opus 5.5 X Hi REVISE.

Documentation batch 4, pass 2: both LAND. R812-B and R812-C are resolved, and both reviewers
support the R812-A veto. No new findings. Final status and verdict metadata were recorded
after these reports; production code and the runnable examples remain as reviewed.

| ID     | Scope               | Model           | Finding                                                              | Severity | Accept/Veto | Evidence                                                                                                                                                                           | Verdict |
| ------ | ------------------- | --------------- | -------------------------------------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| R812-A | Plan lifecycle      | Claude Opus 5.5 | Pending status would be false after a future commit                  | Medium   | Veto        | HEAD is still 560d04e, the index is empty, and commit approval is pending. Current status is true; Task 6 now explicitly requires finalizing metadata at the approved commit step. | LAND    |
| R812-B | Platform validation | Claude Opus 5.5 | CI wording implied it ran the manual ExifTool check on all platforms | Medium   | Accept      | build.yml runs the Mocha suite, which has no ExifTool invocation. The plan now states that the manual check was Linux-only.                                                        | LAND    |
| R812-C | Validation evidence | Claude Opus 5.5 | Archived evidence depended on temporary local paths                  | Medium   | Accept      | The local validation script hard-codes author paths, and review copies have been deleted. The plan now retains measurements and reproducible commands instead of those paths.      | LAND    |

Claude's commit note: the documentation body should explain why the plan is retained. The body
now records the validation and performance constraints for future changes; this is commit advice,
not a substantive finding.

All review scratch copies were deleted after recording the final verdicts on 2026-10-05.

Source reviewer handles (same sessions were resumed):

- Codex CLI: `01a10d5e-7fd3-7a71-9d71-c16eaa5fa646`.
- Claude CLI, `claude-opus-5-5`, effort `xhigh`: `fd6c4ea4-eb3e-49af-a510-9e6ad0060e61`.

Documentation batch 2 reviewer handles:

- Codex CLI: `01a10d79-fae1-7ea2-b6f7-d221be40c0e4`.
- Claude CLI, `claude-opus-5-5`, effort `xhigh`: `014c464b-a78c-4a61-bd0c-50ebc35741aa`.

Documentation batch 3 reviewer handles:

- Codex CLI: `01a10d97-bc00-71e3-964d-43fe6ad5a978`.
- Claude CLI, `claude-opus-5-5`, effort `xhigh`: `5721db21-b2d6-4e2a-b3ed-05a0bb12beda`.

Documentation batch 4 reviewer handles:

- Codex CLI: `01a10d9e-4e76-7d80-b542-79d52ea5a15e`.
- Claude CLI, `claude-opus-5-5`, effort `xhigh`: `64a3c35c-f600-49be-891b-a427d8725943`.

Validation environment notes: the default npm cache made the sandboxed package dry-run exit
226; a writable `/tmp` cache let the package check pass. The sandboxed full Mocha command then
exited without reporting any specs. The same full command outside the sandbox reported all
specs and passed. No production or test-runner changes were needed for these environment issues.
