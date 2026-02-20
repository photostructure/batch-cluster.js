---
name: tpp
description: Resume work on a Technical Project Plan (TPP). Reads the TPP file, determines current phase, and takes appropriate action.
argument-hint: <path-to-tpp>
disable-model-invocation: true
---

# TPP: Resume Technical Project Plan

You are resuming work on a Technical Project Plan (TPP). Your job is to determine what phase the work is in and take appropriate action.

## Required Reading

Before doing ANY work, read and internalize these documents:

1. **CLAUDE.md** — Project conventions and commands
2. **doc/TPP-GUIDE.md** — How to write and execute TPPs
3. **doc/SIMPLE-DESIGN.md** — Kent Beck's Four Rules guide all design decisions
4. **doc/TDD.md** — Bug fixes MUST start with a failing test

These are not optional. Work that ignores them will be rejected.

## Step 1: Read the TPP

Read the TPP file at `$ARGUMENTS`. If no path is provided, list files in `doc/todo/` and ask which TPP to work on.

## Step 2: Determine Current Phase

Examine the TPP's task checklist and context to determine which phase applies:

### Phase: Research & Planning

**Trigger**: Goal defined but tasks are vague or missing context research.
**Actions**:

- Read all files referenced in the TPP
- Run the grep/search commands listed in the TPP to find relevant code
- Update the TPP with findings: existing patterns, landmines, process lifecycle concerns
- Refine tasks with specific file:line references and verification commands
- Mark this phase complete in the TPP

### Phase: Write Breaking Tests

**Trigger**: Bug fix TPP where no failing test exists yet.
**Actions** (per doc/TDD.md):

1. Write a test that reproduces the issue
2. Run it to confirm it fails for the expected reason
3. Update the TPP with the test location and failure output

### Phase: Design Alternatives

**Trigger**: Tasks exist but no solution approach is documented, or the approach seems wrong.
**Actions**:

- Generate 2-4 solution approaches with pros/cons
- Evaluate each against SIMPLE-DESIGN.md rules
- Document preferred approach in the TPP with rationale
- Include code snippets showing the pattern

### Phase: Task Breakdown

**Trigger**: Solution chosen but tasks lack specificity.
**Actions**:

- Break tasks into steps with clear deliverables
- Each task gets: success command, implementation steps with file:line, adaptation notes
- Add completion checklists per the TPP-GUIDE.md template
- Update the TPP

### Phase: Implementation

**Trigger**: Tasks are specific and ready to execute.
**Actions**:

1. Pick the next unchecked task
2. Implement it following the steps in the TPP
3. Run the task's verification command
4. Mark the task complete in the TPP with proof
5. If a task reveals new information, update the TPP's tribal knowledge section
6. Repeat until all tasks are done or context is running low (then use `/handoff`)

### Phase: Review & Refinement

**Trigger**: All tasks marked complete.
**Actions**:

- Review all changed files for SIMPLE-DESIGN.md compliance
- Run `npm test` to verify no regressions
- Run `npm run lint` to verify code style
- Check for shelf-ware: `grep -r "newFunction" src/` — every new feature must be integrated
- Check for dead code: anything obsoleted by the changes should be removed
- Update TPP with review findings

### Phase: Final Integration

**Trigger**: Review passed, all tests green.
**Actions**:

- Run full validation: `npm test`
- Verify all TPP completion checklists are checked
- Move TPP from `doc/todo/` to `doc/done/` with date prefix (e.g., `doc/done/20260208-P01-fix-timeout.md`)
- Report completion status to the user

## Important Reminders

- **Don't blindly follow task lists.** If implementation reveals a better approach, propose revising the TPP.
- **Fail fast.** If something seems wrong, investigate before proceeding.
- **Platform awareness.** Consider Windows, macOS, and Linux behavior differences.
- **Context limits.** If you're running low on context, use `/handoff` before you lose information.
