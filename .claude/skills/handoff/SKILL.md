---
name: handoff
description: Update TPP with current progress for session handoff. Use when context is getting large or you need to pause work.
argument-hint: [path-to-tpp]
disable-model-invocation: true
---

# Handoff: Save Session Progress to TPP

You are preparing a handoff so the next session can continue seamlessly. The goal is to capture everything the next engineer needs to know — as if you're sitting beside them explaining the state of things.

## Step 1: Find the Active TPP

If `$ARGUMENTS` is provided, use that path. Otherwise, look in `doc/todo/` for active TPPs. If multiple exist, ask the user which one to update.

## Step 2: Update Progress

Read the current TPP and update it with:

### Completed Tasks

- Mark finished tasks with `[x]`
- Add proof of completion (test output, grep results, file:line references)

### Current State

- What task were you working on?
- What's the exact state? (e.g., "Test written but not yet passing", "Implementation done, needs review")
- What files were modified? List them with brief descriptions of changes.

### Discoveries & Tribal Knowledge

Add anything the next session needs to know:

- Non-obvious behaviors you encountered
- Code patterns you discovered that are relevant
- Gotchas or landmines you found
- Platform-specific issues observed

### Failed Approaches

Document what you tried that didn't work and why:

- What was the approach?
- Why did it fail?
- What did you learn from it?

This prevents the next session from repeating dead ends.

### Remaining Work

- List remaining tasks with any updated context
- Note any blockers or decisions needed from the user
- If the task breakdown needs revision, explain why

## Step 3: Write the Updated TPP

Write the updated TPP back to the file. Keep it under 400 lines — trim redundant observations while preserving critical information.

## Step 4: Report to User

Summarize:

- What was accomplished this session
- What's next
- Any blockers or decisions needed
- The path to the updated TPP
