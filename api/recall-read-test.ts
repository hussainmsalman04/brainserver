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

    const MAX_ATTEMPTS = 3;
    const attempts = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const generationResponse = await fetch(
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

Do not introduce, infer, assume, or use scientific information that is not
explicitly supported by the BRAIN MATERIAL.

BRAIN MATERIAL:
${file.content}

Generate ONE free-recall question using only the BRAIN MATERIAL.

SELECT THE CONTENT FIRST:
Choose one or two explicit facts or relationships that are directly stated
in the BRAIN MATERIAL.

QUESTION CONSTRAINT:
The answer to the question must be reconstructable directly from the selected
facts or relationships.

Do not invent or add:
- physiological scenarios
- locations or organs
- purposes or functions
- causal explanations
- "why" relationships
- applications
- implications
- contextual conditions
unless they are explicitly stated in the BRAIN MATERIAL.

You may combine two explicitly stated facts into one question.

Prefer questions such as:
- What is the relationship between X and Y?
- How does X differ from Y?
- What happens to X when Y is present?
- Which molecule/enzyme/process has the stated property?

Do not ask questions that require the student to infer information beyond
what the BRAIN MATERIAL explicitly states.

Do not provide the answer.

Return only the question.`,
              },
            ],
          }),
        }
      );

      const generationData = await generationResponse.json();

      if (!generationResponse.ok) {
        return res.status(generationResponse.status).json({
          error: "AI Gateway generation request failed",
          details: generationData,
        });
      }

      const question =
        generationData?.choices?.[0]?.message?.content?.trim();

      if (!question) {
        attempts.push({
          attempt,
          result: "NO_QUESTION",
          generationUsage: generationData?.usage ?? null,
        });

        continue;
      }

      const verifyResponse = await fetch(
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
                content: `You are a strict evidence verifier.

BRAIN MATERIAL:
${file.content}

CANDIDATE QUESTION:
${question}

Determine whether every scientific condition, relationship, assumption,
descriptor, and piece of context required by the CANDIDATE QUESTION is
explicitly supported by the BRAIN MATERIAL.

Do not use outside knowledge.
Do not infer unstated scientific relationships.

If the question is completely supported, reply exactly:
SUPPORTED

If any part requires information not explicitly present in the BRAIN MATERIAL,
reply:
UNSUPPORTED: followed by a brief description of the unsupported information.

Return nothing else.`,
              },
            ],
          }),
        }
      );

      const verifyData = await verifyResponse.json();

      if (!verifyResponse.ok) {
        return res.status(verifyResponse.status).json({
          error: "AI Gateway verification request failed",
          details: verifyData,
        });
      }

      const verification =
        verifyData?.choices?.[0]?.message?.content?.trim() ?? "";

      attempts.push({
        attempt,
        question,
        verification,
        generationUsage: generationData?.usage ?? null,
        verificationUsage: verifyData?.usage ?? null,
      });

      if (verification === "SUPPORTED") {
        return res.status(200).json({
          success: true,
          source: "study/mcat-bbfl.md",
          question,
          verification: "SUPPORTED",
          attempt,
          attempts,
        });
      }
    }

    return res.status(422).json({
      success: false,
      blocked: true,
      source: "study/mcat-bbfl.md",
      error: "No grounded question passed verification after 3 attempts",
      attempts,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
