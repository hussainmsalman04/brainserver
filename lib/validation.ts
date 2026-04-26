/**
 * Path safety: only allow .md files under whitelisted top-level vault dirs.
 * No traversal, no special chars beyond [A-Za-z0-9._/-], no leading slash.
 */

const ALLOWED_DIRS = [
  "00-Home",
  "01-Career",
  "02-Projects",
  "03-Learning",
  "04-Personal",
  "05-Reference",
  "06-Archive",
  "_templates",
] as const;

const PATH_RE = /^[A-Za-z0-9._/-]+\.md$/;

export function validateVaultPath(path: string): string | null {
  if (!path || typeof path !== "string") return "path is required";
  if (path.length > 200) return "path too long";
  if (!PATH_RE.test(path)) return "path must be a .md file with only alphanumerics, dots, underscores, slashes, hyphens";
  if (path.includes("..")) return "path cannot contain ..";
  if (path.startsWith("/")) return "path cannot start with /";
  const top = path.split("/")[0];
  if (!ALLOWED_DIRS.includes(top as any)) {
    return `path must start with one of: ${ALLOWED_DIRS.join(", ")}`;
  }
  return null;
}

export function validateDirectory(dir: string): string | null {
  if (!dir || typeof dir !== "string") return "directory is required";
  if (dir.length > 100) return "directory too long";
  if (!ALLOWED_DIRS.includes(dir as any)) {
    return `directory must be one of: ${ALLOWED_DIRS.join(", ")}`;
  }
  return null;
}

export const ALLOWED_DIRECTORIES = ALLOWED_DIRS;
