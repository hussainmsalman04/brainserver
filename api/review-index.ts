import type { VercelRequest, VercelResponse } from "@vercel/node";
import { VaultClient } from "../lib/github.js";

type Lesson = {
  scope: string;
  chapter: number;
  lesson: number;
  title: string;
};

function cleanHeading(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^Kaplan\s+Bio\s+\d+\.\d+\s*(?:--|—|-)\s*/i, "")
    .replace(/\s+\(cont\.?\)\s*$/i, "")
    .trim();
}

function extractLessons(content: string): Lesson[] {
  const lines = content.split(/\r?\n/);
  const lessons = new Map<string, Lesson>();

  for (let i = 0; i < lines.length; i++) {
    const scopeMatch = lines[i].match(
      /^\s*Scope:\s*Kaplan\s+Bio\s+(\d+)\.(\d+)\s*$/i
    );

    if (!scopeMatch) continue;

    const chapter = parseInt(scopeMatch[1], 10);
    const lesson = parseInt(scopeMatch[2], 10);
    const scope = `${chapter}.${lesson}`;

    if (lessons.has(scope)) continue;

    let title = `Kaplan Bio ${scope}`;

    // Find the nearest heading immediately above the Scope line.
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const candidate = lines[j].trim();

      if (/^#{1,6}\s+/.test(candidate)) {
        const cleaned = cleanHeading(candidate);

        if (cleaned) {
          title = cleaned;
        }

        break;
      }
    }

    lessons.set(scope, {
      scope,
      chapter,
      lesson,
      title,
    });
  }

  return [...lessons.values()].sort(
    (a, b) =>
      a.chapter - b.chapter ||
      a.lesson - b.lesson
  );
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const githubToken = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const branch = process.env.GITHUB_BRANCH;

  if (!githubToken || !owner || !repo || !branch) {
    return res.status(500).json({
      error: "Required environment variable is missing",
    });
  }

  try {
    const vault = new VaultClient(githubToken, {
      owner,
      repo,
      branch,
    });

    const file = await vault.readFile(
      "study/mcat-bbfl.md"
    );

    if (!file) {
      return res.status(404).json({
        error: "study/mcat-bbfl.md was not found",
      });
    }

    return res.status(200).json({
      success: true,
      lessons: extractLessons(file.content),
    });
  } catch (error) {
    return res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
}
