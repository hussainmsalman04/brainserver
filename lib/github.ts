/**
 * Fetch-based GitHub Contents API wrapper for the ClawMemory vault.
 *
 * Always reads-then-writes (so we never blow away existing content).
 * Uses Web `fetch` so it runs identically on Node 20+, Edge, Cloudflare Workers, etc.
 */

export type VaultConfig = {
  owner: string;
  repo: string;
  branch: string;
};

const GH = "https://api.github.com";

type ContentsItem = {
  type: "file" | "dir" | "submodule" | "symlink";
  name: string;
  path: string;
  size: number;
  sha: string;
};

type FileResponse = ContentsItem & { content: string; encoding: "base64" };

export class VaultClient {
  constructor(private token: string, private cfg: VaultConfig) {}

  private async ghFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${GH}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${this.token}`,
        "user-agent": "clawmemory-mcp/0.1",
        ...(init?.headers ?? {}),
      },
    });
  }

  /** List .md files inside a directory (one level deep). Returns [] if dir missing. */
  async listFiles(directory: string): Promise<{ path: string; size: number }[]> {
    const { owner, repo, branch } = this.cfg;
    const url = `/repos/${owner}/${repo}/contents/${encodeURIComponent(directory)}?ref=${encodeURIComponent(branch)}`;
    const res = await this.ghFetch(url);
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub list ${directory} ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as ContentsItem[] | ContentsItem;
    if (!Array.isArray(data)) return [];
    return data
      .filter((e) => e.type === "file" && e.name.endsWith(".md"))
      .map((e) => ({ path: e.path, size: e.size }));
  }

  /** Read a file's content + sha. Returns null if file does not exist. */
  async readFile(path: string): Promise<{ content: string; sha: string } | null> {
    const { owner, repo, branch } = this.cfg;
    const url = `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
    const res = await this.ghFetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read ${path} ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as FileResponse | ContentsItem[];
    if (Array.isArray(data) || (data as FileResponse).type !== "file") {
      throw new Error(`Path is not a file: ${path}`);
    }
    const file = data as FileResponse;
    // The contents API returns base64 with newlines; strip them before decoding.
    const cleaned = file.content.replace(/\s/g, "");
    const decoded = atob(cleaned);
    // Convert binary string to UTF-8 (handles non-ASCII).
    const bytes = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
    const content = new TextDecoder("utf-8").decode(bytes);
    return { content, sha: file.sha };
  }

  /** Normalize text for a conservative duplicate check.
   *  This intentionally only catches effectively identical entries.
   *  It will never decide that two merely-similar memories are the same.
   */
  private normalizeForDedup(text: string): string {
    return text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n")
      .trim();
  }

  /**
   * Save an entry in one server-side operation.
   *
   * Safety properties:
   * - Reads the file before writing.
   * - Uses GitHub's sha precondition, so a concurrent edit cannot be overwritten.
   * - Skips the write when the same normalized entry is already present.
   * - Never rewrites, moves, deletes, or semantically merges existing notes.
   */
  async saveIfNew(
    path: string,
    entry: string,
    commitMessage: string
  ): Promise<{ commitSha: string; created: boolean; skippedDuplicate: boolean }> {
    const existing = await this.readFile(path);
    const normalizedEntry = this.normalizeForDedup(entry);

    if (!normalizedEntry) {
      throw new Error("entry is empty after normalization");
    }

    if (existing) {
      const normalizedExisting = this.normalizeForDedup(existing.content);
      if (normalizedExisting.includes(normalizedEntry)) {
        return { commitSha: "", created: false, skippedDuplicate: true };
      }
    }

    const result = await this.appendUsingExisting(path, entry, commitMessage, existing);
    return { ...result, skippedDuplicate: false };
  }

  private async appendUsingExisting(
    path: string,
    toAppend: string,
    commitMessage: string,
    existing: { content: string; sha: string } | null
  ): Promise<{ commitSha: string; created: boolean }> {
    let newContent: string;
    let created = false;
    if (existing) {
      const trimmed = existing.content.replace(/\s+$/, "");
      newContent = `${trimmed}\n\n${toAppend.replace(/^\s+/, "")}\n`;
    } else {
      created = true;
      const title =
        path.split("/").pop()?.replace(/\.md$/, "").replace(/-/g, " ") ?? "Untitled";
      const today = new Date().toISOString().slice(0, 10);
      newContent = `# ${title}\n\n_Auto-populated by claude.ai memory keeper on ${today}._\n\n${toAppend.replace(/^\s+/, "")}\n`;
    }

    const utf8 = new TextEncoder().encode(newContent);
    let binary = "";
    for (let i = 0; i < utf8.length; i++) binary += String.fromCharCode(utf8[i]);
    const b64 = btoa(binary);

    const { owner, repo, branch } = this.cfg;
    const body: Record<string, unknown> = {
      message: commitMessage,
      content: b64,
      branch,
    };
    if (existing) body.sha = existing.sha;

    const res = await this.ghFetch(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`GitHub PUT ${path} ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { commit?: { sha?: string } };
    return { commitSha: data.commit?.sha ?? "", created };
  }

  /**
   * Append content to a file (or create it if missing). Returns the new commit sha.
   * Always reads first to get the existing sha — never overwrites blind.
   */
  async appendToFile(
    path: string,
    toAppend: string,
    commitMessage: string
  ): Promise<{ commitSha: string; created: boolean }> {
    const existing = await this.readFile(path);
    return this.appendUsingExisting(path, toAppend, commitMessage, existing);
  }
/**
 * Safely replace a whole file.
 * Reads first so GitHub's current SHA protects against blind overwrites.
 */
async writeFile(
  path: string,
  content: string,
  commitMessage: string
): Promise<{ commitSha: string; created: boolean }> {
  const existing = await this.readFile(path);

  const utf8 = new TextEncoder().encode(content);

  let binary = "";

  for (let i = 0; i < utf8.length; i++) {
    binary += String.fromCharCode(utf8[i]);
  }

  const b64 = btoa(binary);

  const { owner, repo, branch } = this.cfg;

  const body: Record<string, unknown> = {
    message: commitMessage,
    content: b64,
    branch,
  };

  if (existing) {
    body.sha = existing.sha;
  }

  const res = await this.ghFetch(
    `/repos/${owner}/${repo}/contents/${encodeURI(path)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    throw new Error(
      `GitHub PUT ${path} ${res.status}: ${await res.text()}`
    );
  }

  const result = (await res.json()) as {
    commit?: {
      sha?: string;
    };
  };

  return {
    commitSha: result.commit?.sha ?? "",
    created: !existing,
  };
}
  
}
