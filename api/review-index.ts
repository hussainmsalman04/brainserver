import type { VercelRequest, VercelResponse } from "@vercel/node";
import { VaultClient } from "../lib/github.js";

type Lesson = {
  scope: string;
  chapter: number;
  lesson: number;
  title: string;
};

function extractLessons(content: string): Lesson[] {
  const lessons = new Map<string, Lesson>();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(
      /^##\s+Kaplan\s+Bio\s+(\d+)\.(\d+)\s+--\s+(.+?)\s*$/i
    );

    if (!match) continue;

    const chapter = parseInt(match[1], 10);
    const lesson = parseInt(match[2], 10);
    const scope = `${chapter}.${lesson}`;

    // First heading for a lesson wins.
    // This prevents "(cont.)" sections from creating duplicate rows.
    if (!lessons.has(scope)) {
      lessons.set(scope, {
        scope,
        chapter,
        lesson,
        title: match[3]
          .replace(/\s+\(cont\.?\)\s*$/i, "")
          .trim(),
      });
    }
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
