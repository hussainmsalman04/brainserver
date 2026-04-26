/**
 * Thin wrapper around the GitHub Contents API for the ClawMemory vault.
 *
 * Always reads-then-writes (so we never blow away existing content), and uses
 * base64 encoding because that's what `PUT /repos/{owner}/{repo}/contents/{path}` requires.
 */

import { Octokit } from "@octokit/rest";

export type VaultConfig = {
  owner: string;
  repo: string;
  branch: string;
};

export class VaultClient {
  private octokit: Octokit;
  constructor(token: string, private cfg: VaultConfig) {
    this.octokit = new Octokit({ auth: token });
  }

  /** List .md files inside a directory (one level deep). Returns [] if dir missing. */
  async listFiles(directory: string): Promise<{ path: string; size: number }[]> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.cfg.owner,
        repo: this.cfg.repo,
        path: directory,
        ref: this.cfg.branch,
      });
      if (!Array.isArray(data)) return [];
      return data
        .filter((e) => e.type === "file" && e.name.endsWith(".md"))
        .map((e) => ({ path: e.path, size: e.size ?? 0 }));
    } catch (err: any) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  /** Read a file's content + sha. Returns null if file does not exist. */
  async readFile(path: string): Promise<{ content: string; sha: string } | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.cfg.owner,
        repo: this.cfg.repo,
        path,
        ref: this.cfg.branch,
      });
      if (Array.isArray(data) || data.type !== "file") {
        throw new Error(`Path is not a file: ${path}`);
      }
      const content = Buffer.from(data.content, "base64").toString("utf8");
      return { content, sha: data.sha };
    } catch (err: any) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Append content to a file (or create it if missing). Returns the new commit sha.
   * Always reads first to get the existing sha — never overwrites blind.
   */
  async appendToFile(path: string, toAppend: string, commitMessage: string): Promise<{ commitSha: string; created: boolean }> {
    const existing = await this.readFile(path);
    let newContent: string;
    let created = false;
    if (existing) {
      // Ensure exactly one blank line separates old and new content.
      const trimmed = existing.content.replace(/\s+$/, "");
      newContent = `${trimmed}\n\n${toAppend.replace(/^\s+/, "")}\n`;
    } else {
      created = true;
      const title = path.split("/").pop()?.replace(/\.md$/, "").replace(/-/g, " ") ?? "Untitled";
      const today = new Date().toISOString().slice(0, 10);
      newContent = `# ${title}\n\n_Auto-populated by claude.ai memory keeper on ${today}._\n\n${toAppend.replace(/^\s+/, "")}\n`;
    }

    const { data } = await this.octokit.repos.createOrUpdateFileContents({
      owner: this.cfg.owner,
      repo: this.cfg.repo,
      path,
      message: commitMessage,
      content: Buffer.from(newContent, "utf8").toString("base64"),
      branch: this.cfg.branch,
      sha: existing?.sha,
    });
    return { commitSha: data.commit.sha ?? "", created };
  }
}
