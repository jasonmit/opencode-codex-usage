# Readable spacing rule

The rule at `rules/require-readable-spacing.ts` and the five files under
`vendor/eslint-stylistic/` were copied from the `install-anti-slop` skill's
`assets/anti-slop/` directory. This vendored snapshot is self-contained;
building it does not depend on the skill being installed.
The copied rule's SHA-256 is
`e63084ad77e215ad25e963c452d8ee819fb1cac3aefe3401e169985a145ac4bc`.
The nested `vendor/eslint-stylistic/UPSTREAM.md` documents the upstream
ESLint Stylistic revision, local adaptations, and license.

`index.ts` is local glue registering **only** this spacing rule with Oxlint.
No other rules from the skill are installed.
