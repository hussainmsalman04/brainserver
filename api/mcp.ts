/**
 * MCP server for ClawMemory vault.
 *
 * Vercel Node serverless function. Uses the legacy (req, res) signature
 * because Vercel's nodejs runtime dispatches that reliably; pairs naturally
 * with the SDK's Node-style StreamableHTTPServerTransport.
 *
 * Tools exposed:
 *   - list_vault_files
 *   - read_vault_file
 *   - append_to_vault
 *
 * Auth: Bearer token in Authorization header, validated against MCP_BEARER_TOKEN.
 * Storage: GitHub Contents API on the configured repo + branch.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { VaultClient } from "../lib/github.js";
import { ALLOWED_DIRECTORIES, validateDirectory, validateVaultPath } from "../lib/validation.js";

// ---------- Tool input schemas ----------

const ListFilesInput = z.object({ directory: z.string() });
const ReadFileInput = z.object({ path: z.string() });
const AppendInput = z.object({
  path: z.string(),
  entry: z.string(),
  commit_message: z.string().optional(),
});

// ---------- Build MCP server ----------

function buildServer(vault: VaultClient): Server {
  const server = new Server(
    { name: "clawmemory-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_vault_files",
        description:
          "List all .md files inside a vault directory. Use this BEFORE planning saves so you know which topic files already exist.",
        inputSchema: {
          type: "object",
          properties: {
            directory: { type: "string", description: `One of: ${ALLOWED_DIRECTORIES.join(", ")}.` },
          },
          required: ["directory"],
        },
      },
      {
        name: "read_vault_file",
        description:
          "Read the current content of a vault file. Use this to dedup against existing entries BEFORE appending — never write a fact that's already there.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Vault path like `01-Career/Job-Search-State.md`." },
          },
          required: ["path"],
        },
      },
      {
        name: "append_to_vault",
        description:
          "Append a structured markdown entry to a vault file (creates the file if missing). The server reads-then-writes safely with the existing file's sha — you cannot accidentally overwrite. Always read_vault_file first to dedup.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Vault path like `04-Personal/Health.md`." },
            entry: {
              type: "string",
              description:
                "Markdown to append. Should begin with `## YYYY-MM-DD — <short topic>` and include Context / What he said / Facts / Open sections.",
            },
            commit_message: { type: "string", description: "Optional git commit message." },
          },
          required: ["path", "entry"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      if (name === "list_vault_files") {
        const { directory } = ListFilesInput.parse(args);
        const err = validateDirectory(directory);
        if (err) return toolError(err);
        const files = await vault.listFiles(directory);
        if (files.length === 0) return toolText(`No .md files in ${directory}/ yet.`);
        const lines = files.map((f) => `- ${f.path} (${f.size} bytes)`).join("\n");
        return toolText(`${files.length} file(s) in ${directory}/:\n${lines}`);
      }

      if (name === "read_vault_file") {
        const { path } = ReadFileInput.parse(args);
        const err = validateVaultPath(path);
        if (err) return toolError(err);
        const file = await vault.readFile(path);
        if (!file) return toolText(`(file does not exist: ${path})`);
        return toolText(file.content);
      }

      if (name === "append_to_vault") {
        const { path, entry, commit_message } = AppendInput.parse(args);
        const err = validateVaultPath(path);
        if (err) return toolError(err);
        if (entry.length > 50_000) return toolError("entry too long (max 50000 chars)");
        const message = commit_message ?? `memory: append to ${path} (claude.ai)`;
        const { commitSha, created } = await vault.appendToFile(path, entry, message);
        return toolText(
          `${created ? "Created and wrote" : "Appended to"} ${path}. Commit ${commitSha.slice(0, 7)}.`
        );
      }

      return toolError(`Unknown tool: ${name}`);
    } catch (err: any) {
      return toolError(`Tool '${name}' failed: ${err?.message ?? String(err)}`);
    }
  });

  return server;
}

function toolText(text: string) {
  return { content: [{ type: "text", text }] };
}
function toolError(text: string) {
  return { content: [{ type: "text", text: `ERROR: ${text}` }], isError: true };
}

// ---------- Auth ----------

function checkAuth(req: VercelRequest): { ok: true } | { ok: false; reason: string } {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || expected.length < 16) {
    return { ok: false, reason: "Server misconfigured: MCP_BEARER_TOKEN missing or too short" };
  }

  // Accept token from EITHER the Authorization: Bearer header OR a ?token=... query param.
  // Query-param mode is needed because claude.ai's "Add custom connector" UI doesn't expose
  // a header field — only OAuth, which would be heavier to implement.
  let provided: string | undefined;
  const header = (req.headers["authorization"] ?? "") as string;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (m) {
    provided = m[1].trim();
  } else if (typeof req.query?.token === "string") {
    provided = req.query.token;
  }

  if (!provided) {
    return {
      ok: false,
      reason: "Missing token. Provide via `Authorization: Bearer <token>` header or `?token=...` query param.",
    };
  }
  if (provided.length !== expected.length) return { ok: false, reason: "Invalid token" };
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? { ok: true } : { ok: false, reason: "Invalid token" };
}

// ---------- Vercel handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, mcp-session-id, mcp-protocol-version"
  );
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const auth = checkAuth(req);
  if (!auth.ok) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: auth.reason });
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const branch = process.env.GITHUB_BRANCH ?? "main";
  if (!token || !owner || !repo) {
    res.status(500).json({
      error: "Server misconfigured: missing GITHUB_TOKEN / GITHUB_REPO_OWNER / GITHUB_REPO_NAME",
    });
    return;
  }

  try {
    const vault = new VaultClient(token, { owner, repo, branch });
    const server = buildServer(vault);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    // Vercel parses JSON bodies for us when content-type is application/json.
    // The transport expects the parsed body as the third arg (or undefined).
    const parsedBody = typeof req.body === "object" ? req.body : undefined;
    await transport.handleRequest(req as any, res as any, parsedBody);
  } catch (err: any) {
    console.error("MCP handler error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  }
}
