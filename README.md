# claude-tooling

A small collection of dev-side tools around [Claude Code](https://docs.claude.com/en/docs/claude-code/overview). Each subdirectory is an independent project with its own README and dependencies — there is no top-level build.

## Projects

- **[`local-proxy/`](./local-proxy)** — Bun + Hono proxy that routes Claude Code traffic to a local OpenAI-compatible model (LM Studio, Ollama, vLLM) while leaving tool-using requests on Anthropic. Listens on `:8787`; point `ANTHROPIC_BASE_URL` at it. See [`local-proxy/README.md`](./local-proxy/README.md) for setup.

## Conventions

- Each subproject is self-contained — `cd <subproject> && bun install && bun run start`.
- TypeScript projects target [Bun](https://bun.sh), not Node. Use `bun run`, not `npm run` or `node`.
- Secrets live in per-subproject `.env` files (gitignored). `.env.example` is always kept current.

## Adding a new subproject

1. Create a sibling directory with its own `README.md` covering: what it does, install, run, env vars, and known limitations.
2. Add a one-line entry under **Projects** above pointing at it.
3. Keep it self-contained — no shared `package.json`, no shared lockfile.

## License

[MIT](./LICENSE) © 2026 Vlad
