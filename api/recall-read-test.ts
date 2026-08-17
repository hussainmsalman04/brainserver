import type { VercelRequest, VercelResponse } from "@vercel/node";
import { VaultClient } from "../lib/github.js";
import { checkAuth } from "../lib/auth.js";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
    });
  }
const authRequest = new Request("https://brainserver.local", {
  headers: {
    authorization:
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : "",
  },
});

const auth = checkAuth(authRequest);

if (!auth.ok) {
  return res.status(401).json({
    error: auth.reason,
  });
}
  const aiKey = process.env.AI_GATEWAY_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_REPO_OWNER;
  const repo = process.env.GITHUB_REPO_NAME;
  const branch = process.env.GITHUB_BRANCH;

  if (!aiKey || !githubToken || !owner || !repo || !branch) {
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

    const file = await vault.readFile("study/mcat-bbfl.md");

    if (!file) {
      return res.status(404).json({
        error: "study/mcat-bbfl.md was not found",
      });
    }

    const response = await fetch(
      "https://ai-gateway.vercel.sh/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3.1-flash-lite",
          messages: [
            {
              role: "user",
              content: `You are an evidence-bound MCAT active-recall examiner.

STRICT GROUNDING RULE:
The BRAIN MATERIAL below is the complete source for this task.

Do not introduce, infer, or use scientific information that is not explicitly
supported by the BRAIN MATERIAL.

BRAIN MATERIAL:
${file.content}

Generate ONE free-recall question using only the BRAIN MATERIAL.

The question should test understanding, relationships, mechanisms, or
comparisons when the source supports them rather than simple recognition.

Do not provide the answer.

Return only the question.`,
            },
          ],
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "AI Gateway request failed",
        details: data,
      });
    }

    return res.status(200).json({
      success: true,
      source: "study/mcat-bbfl.md",
      question: data?.choices?.[0]?.message?.content,
      usage: data?.usage ?? null,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
