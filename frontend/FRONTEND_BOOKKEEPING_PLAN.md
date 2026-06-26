# Frontend Bookkeeping Plan

## Audit Summary

- `frontend/src/app/styles.css` is too large and mixes global, feature, and component styling.
- Several components are too large to maintain comfortably:
  - `ThemeManagementPage.tsx`
  - `TickerDetailsDialog.tsx`
  - `RrgPage.tsx`
- State is mostly local and understandable, but repeated patterns exist around local storage, async loading, polling, and selection sets.
- Performance-sensitive areas are acceptable today, but should be isolated:
  - RRG canvas draw and hit-test duplicate viewport calculations.
  - Ticker streaming is throttled appropriately.
  - Theme management polls broad data every 10 seconds.
- CSS reuse is partial. Feature styles should move closer to feature ownership.

## Plan

1. Split CSS by ownership.
   - Keep app shell and shared primitives in `app/styles.css`.
   - Move feature styles into files such as:
     - `features/ticker-lens/ticker-lens.css`
     - `features/rrg/rrg.css`
     - `features/theme-management/theme-management.css`
     - `components/ticker-details-dialog.css`

2. Extract shared hooks.
   - `useLocalStorageState`
   - `useDebouncedValue`
   - Small async request/loading helper
   - Selection helpers for `Set` state if reuse is clear

3. Break large components into medium components.
   - `RrgPage`: controls, theme list, right pane, canvas helpers.
   - `TickerDetailsDialog`: fundamentals tab, profile/themes tab, chart helpers.
   - `ThemeManagementPage`: one file per tab plus shared utilities.

4. Normalize component boundaries.
   - Page components own orchestration.
   - Child components render focused UI from explicit props.
   - Pure sorting/filtering/transforms move into feature `utils.ts`.

5. Reduce performance risk.
   - Share RRG viewport calculation between draw and hit-test.
   - Revisit Theme Management polling scope.
   - Avoid expensive fingerprints unless they are necessary.

6. Standardize styling conventions.
   - Remove static inline styles where practical.
   - Keep dynamic inline styles only for runtime values like chart colors or drag positions.
   - Reuse existing list/header/button patterns.

7. Validate each phase.
   - Run `npm run check`.
   - Run `git diff --check`.
   - Add tests only if a test framework is already introduced separately.

## TODO

- [x] Split `app/styles.css` by ownership.
- [x] Add shared local storage/debounce/request helper hooks where reuse is clear.
- [x] Break `RrgPage.tsx` into medium-sized components and canvas helpers.
- [x] Break `TickerDetailsDialog.tsx` into focused tab/chart components.
- [ ] Break `ThemeManagementPage.tsx` into tab-level files and shared utilities.
- [ ] Move pure sorting/filtering/transforms into feature `utils.ts` files.
- [x] Share RRG viewport calculation between draw and hit-test.
- [ ] Review Theme Management polling scope.
- [ ] Remove avoidable static inline styles.
- [ ] Run `npm run check` and `git diff --check` after each completed phase.

## Progress Notes

- CSS ownership split is complete. `app/styles.css` now contains app shell, navigation, and shared primitives only.
- RRG decomposition is complete for the current phase: controls, theme list, right pane, shared RRG types/constants, and shared viewport calculation have been extracted. Canvas drawing and event wiring remain in `RrgPage.tsx` as page-owned behavior.
- Shared `useLocalStorageState` and `useDebouncedValue` hooks are in place and used by RRG. A shared request helper is deferred until another feature needs the same abstraction.
- `TickerDetailsDialog` now owns dialog orchestration only; fundamentals charts and profile/theme assignment UI are extracted into focused components.
