# clawmemory-mcp

An MCP server that lets `claude.ai` append durable memory entries to Aayush's Obsidian vault on GitHub.

## What it does

Exposes three tools to claude.ai over the streamable-HTTP MCP protocol:

| Tool | Purpose |
|---|---|
| `list_vault_files` | List `.md` files in a vault directory — used for dedup planning |
| `read_vault_file` | Fetch existing content of a vault file — used for fact-level dedup |
| `append_to_vault`  | Append a structured markdown entry to a file (creates if missing). Server reads-then-writes safely with the existing sha — never overwrites blind |

The GitHub PAT lives as an encrypted env var on Vercel; it never appears in any chat or claude.ai project setting.

## Endpoints

- `POST /api/mcp` — the MCP endpoint claude.ai talks to. Requires `Authorization: Bearer <MCP_BEARER_TOKEN>`.

## Local dev

```bash
npm install
cp .env.local.example .env.local   # fill in the values
npx vercel dev
```

## Deploy

```bash
npx vercel link
npx vercel env add GITHUB_TOKEN production
npx vercel env add GITHUB_REPO_OWNER production
npx vercel env add GITHUB_REPO_NAME production
npx vercel env add GITHUB_BRANCH production
npx vercel env add MCP_BEARER_TOKEN production
npx vercel deploy --prod
```

## Wire up claude.ai

1. Settings → Connectors → Add custom connector
2. Name: `ClawMemory`
3. URL: `https://<your-vercel-deployment>.vercel.app/api/mcp`
4. Auth: Bearer, value = `MCP_BEARER_TOKEN`
5. Add connector to the **Brain** project

After that, in any chat in the Brain project, claude.ai will see `list_vault_files`, `read_vault_file`, `append_to_vault` as available tools. Just type `save to brain`.
