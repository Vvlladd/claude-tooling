# claude-tooling

Dev-side tooling that supports the iOS/visionOS work in the parent directory but isn't itself a shippable app or library. Each subdirectory is an independent project with its own README and dependencies — there is no top-level build.

## Subprojects

- **`local-proxy/`** — Bun + Hono shim that translates Anthropic Messages → OpenAI Chat Completions, letting Claude Code route text-only requests to LM Studio (or any OpenAI-compatible local server) while leaving tool-using requests on Anthropic. Listens on `:8787`. See `local-proxy/README.md` for routing rules, env vars, and known limitations.

## Conventions

- Each subproject is self-contained: install deps and run from inside its own directory (`cd local-proxy && bun install && bun run start`).
- TypeScript projects target Bun, not Node. Use `bun run`, not `npm run` or `node`.
- Secrets live in per-subproject `.env` files (gitignored). `.env.example` should always be present and current.

## When adding a new subproject

- Create a sibling directory with its own `README.md` covering: what it does, how to install, how to run, env vars, and known limitations.
- Add a one-line entry under **Subprojects** above pointing at it.
- Keep it self-contained — no shared package.json, no shared lockfile.
