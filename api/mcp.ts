/**
 * MCP server for ClawMemory vault.
 *
 * Single Vercel function that speaks the streamable-HTTP MCP protocol.
 * Exposes three tools:
 *   - list_vault_files   : list .md files under a vault directory
 *   - read_vault_file    : fetch a vault file's content (so claude.ai can dedup before appending)
 *   - append_to_vault    : append a dated markdown entry to a vault file (creates file if missing)
 *
 * Auth: Bearer token in Authorization header, checked against MCP_BEARER_TOKEN env.
 * Storage: GitHub Contents API on the configured repo + branch.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { VaultClient } from "../lib/github.js";
import { checkAuth } from "../lib/auth.js";
import { ALLOWED_DIRECTORIES, validateDirectory, validateVaultPath } from "../lib/validation.js";

export const config = {
  runtime: "edge",
};

// ---------- Tool input schemas ----------

const ListFilesInput = z.object({
  directory: z
    .string()
    .describe(`One of: ${ALLOWED_DIRECTORIES.join(", ")}.`),
});

const ReadFileInput = z.object({
  path: z
    .string()
    .describe(
      "Path within the vault, e.g. `01-Career/Job-Search-State.md`. Must be a `.md` under an allowed top-level directory."
    ),
});

const AppendInput = z.object({
  path: z.string().describe("Vault path, e.g. `04-Personal/Health.md`."),
  entry: z
    .string()
    .describe(
      "Markdown content to append. Should typically start with a `## YYYY-MM-DD — <topic>` header followed by Context / What he said / Facts / Open sections."
    ),
  commit_message: z
    .string()
    .optional()
    .describe("Optional git commit message. Defaults to `memory: append to <path> (claude.ai)`."),
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
            directory: {
              type: "string",
              description: `One of: ${ALLOWED_DIRECTORIES.join(", ")}.`,
            },
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
            path: {
              type: "string",
              description: "Vault path like `01-Career/Job-Search-State.md`.",
            },
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
            path: {
              type: "string",
              description: "Vault path like `04-Personal/Health.md`.",
            },
            entry: {
              type: "string",
              description:
                "Markdown to append. Should begin with `## YYYY-MM-DD — <short topic>` and include Context / What he said / Facts / Open sections.",
            },
            commit_message: {
              type: "string",
              description: "Optional git commit message.",
            },
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

// ---------- Vercel handler (Web Fetch API) ----------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const auth = checkAuth(req);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.reason }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
        ...CORS_HEADERS,
      },
    });
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const branch = process.env.GITHUB_BRANCH ?? "main";
  if (!token || !owner || !repo) {
    return new Response(
      JSON.stringify({
        error:
          "Server misconfigured: missing GITHUB_TOKEN / GITHUB_REPO_OWNER / GITHUB_REPO_NAME",
      }),
      {
        status: 500,
        headers: { "content-type": "application/json", ...CORS_HEADERS },
      }
    );
  }

  const vault = new VaultClient(token, { owner, repo, branch });
  const server = buildServer(vault);

  // Stateless transport — each Vercel invocation creates a fresh one.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);

  const response = await transport.handleRequest(req);

  // Mix CORS headers into the SDK's response.
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) merged.set(k, v);
  return new Response(response.body, { status: response.status, headers: merged });
}
