# Agent Guidelines

## TypeScript Evidence

- Preserve inferred literal keys and values. Prefer inference, `as const`, or `satisfies` over broad annotations.
- Parse untrusted input at boundaries with Zod. Do not assert parsed JSON or external event payloads into trusted types.
- Avoid chained assertions, widen-then-assert flows, `Reflect.get`, and `Reflect.apply`.
- Treat type assertions as a last resort. Add a nearby `SAFETY:` comment describing the checked invariant when one is unavoidable.
- Prefer explicit assignments or control flow over conditional spreads that use `{}` as the false branch.
- Keep dictionary types narrow. Use a concrete value contract instead of `any`, `object`, or `{}`.
- Use `unknown` only at genuine external boundaries and narrow it immediately. Existing OpenCode event metadata and caught errors are valid boundaries.
- Do not use module mocking when dependency injection or a real boundary fake can exercise the behavior.

## Verification

- Add regression tests before behavior changes and bug fixes.
- Run `npm test`, `npm run build`, and `npm run format:check` before completion.
