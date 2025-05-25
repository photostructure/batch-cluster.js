# Code Review TODO List for batch-cluster.js


## 4. **Extract Responsibilities from BatchCluster** 📦
- [x] Create `ProcessPoolManager` class for process lifecycle management
- [x] Create `TaskQueueManager` class with test for task scheduling and assignment
- [x] Create `ProcessHealthMonitor` class with test for health checking logic
- [x] Create `BatchClusterEventCoordinator` with test for centralized event handling

## 5. **Extract Responsibilities from BatchProcess** 📦
- [x] Create `StreamHandler` class for stdout/stderr processing
- [x] Extract process termination logic into separate utility
- [ ] Move health check logic to shared `ProcessHealthMonitor`

## 6. **Refactor Long Methods** 📏
- [ ] Break down `BatchCluster.#maybeSpawnProcs()` into smaller methods
- [ ] Break down `BatchProcess.#end()` into smaller methods
- [ ] Refactor `BatchProcess.whyNotHealthy` using strategy pattern
- [ ] Simplify `BatchCluster.vacuumProcs()` logic

## 7. **Reduce Coupling** 🔗
- [ ] Create clear interfaces between BatchCluster and BatchProcess
- [ ] Remove direct Task manipulation from BatchProcess
- [ ] Use dependency injection for options instead of inheritance

## 8. **Consolidate Duplicate Logic** 🔄
- [ ] Create shared error handling utilities
- [ ] Consolidate timeout management patterns
- [ ] Unify state transition logic (ending/ended states)
- [ ] Extract common stream destruction patterns

## 9. **Modernize TypeScript Usage** 🆕
- [x] Use optional chaining (`?.`) throughout (already well used)
- [x] Use nullish coalescing (`??`) instead of `|| undefined` (already well used)
- [ ] Consider using `satisfies` operator for type safety
- [ ] Use const assertions where appropriate

## 10. **Improve Type Safety** 🛡️
- [x] Replace `any` types with proper types where possible (replaced most with `unknown`)
- [x] Add more specific return types instead of relying on inference (added BatchClusterStats)
- [ ] Consider using discriminated unions for state management

## 11. **Performance Optimizations** ⚡
- [ ] Review `filterInPlace` usage - native `filter` might be sufficient
- [ ] Consider using `Set` instead of arrays for process management
- [ ] Review if custom `Mean` class is necessary vs simple calculations

## 12. **Documentation & Naming** 📝
- [ ] Rename private fields to follow consistent naming (some use `#_field`)
- [ ] Add JSDoc comments for complex methods
- [ ] Consider renaming `whyNotHealthy` to `getHealthIssues` or similar

## 13. **Testing Improvements** 🧪
- [ ] Extract test utilities from main codebase
- [ ] Consider moving `DefaultTestOptions.spec.ts` logic to test setup

## 14. **Configuration Simplification** ⚙️
- [ ] Review if all configuration options are necessary
- [ ] Consider using builder pattern for complex configurations
- [ ] Consolidate similar timeout options

## Priority Recommendations

### High Priority (Quick Wins)
1. Remove unused code (Section 1)
2. Replace custom utilities with built-ins (Section 2)
3. Simplify utility functions (Section 3)

### Medium Priority (Structural Improvements)
4. Extract responsibilities from god classes (Sections 4-5)
5. Refactor long methods (Section 6)
6. Reduce coupling (Section 7)

### Low Priority (Polish)
7. Modernize TypeScript usage (Section 9)
8. Performance optimizations (Section 11)
9. Documentation improvements (Section 12)

## Notes
- The codebase is generally well-written but shows signs of organic growth
- Main issue: `BatchCluster` and `BatchProcess` have become "god classes" with too many responsibilities
- Breaking these apart would significantly improve maintainability and testability
- Start with high-priority items for immediate impact