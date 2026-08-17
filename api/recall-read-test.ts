import type { VercelRequest, VercelResponse } from "@vercel/node";
import { VaultClient } from "../lib/github.js";
import { checkAuth } from "../lib/auth.js";
function extractBrainSection(
  content: string,
  scope: string
): string | null {
  const target = scope.trim().toLowerCase();

  if (!target) {
    return content;
  }

  const lines = content.split(/\r?\n/);

  const startIndex = lines.findIndex((line) => {
    const match = line.match(/^(#+)\s+(.+?)\s*$/);

    return (
      !!match &&
      match[2].toLowerCase().includes(target)
    );
  });

  if (startIndex === -1) {
    return null;
  }

  const headingMatch =
    lines[startIndex].match(/^(#+)\s+/);

  if (!headingMatch) {
    return null;
  }

  const headingLevel = headingMatch[1].length;
  let endIndex = lines.length;

  for (
    let index = startIndex + 1;
    index < lines.length;
    index++
  ) {
    const nextHeading =
      lines[index].match(/^(#+)\s+/);

    if (
      nextHeading &&
      nextHeading[1].length <= headingLevel
    ) {
      endIndex = index;
      break;
    }
  }

  return lines
    .slice(startIndex, endIndex)
    .join("\n")
    .trim();
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

const scope =
  typeof req.query?.scope === "string"
    ? req.query.scope.trim()
    : "";

const coveredDimensionsRaw =
  typeof req.query?.coveredDimensions === "string"
    ? req.query.coveredDimensions.trim()
    : "";

let coveredDimensions: string[] = [];

if (coveredDimensionsRaw) {
  try {
    const parsed = JSON.parse(coveredDimensionsRaw);

    if (Array.isArray(parsed)) {
      coveredDimensions = parsed.filter(
        (dimension): dimension is string =>
          typeof dimension === "string"
      );
    }
  } catch {
    coveredDimensions = [];
  }
}

const brainMaterial = extractBrainSection(
  file.content,
  scope
);
    
if (!brainMaterial) {
  return res.status(404).json({
    error: `Review scope was not found in the Brain: ${scope}`,
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
${brainMaterial}

Generate ONE free-recall question using only the BRAIN MATERIAL.

Before writing the question, select ONE or TWO specific knowledge facts or
relationships from the BRAIN MATERIAL that the question will test.

The selected facts or relationships define the COMPLETE target of the
question.

COVERED DIMENSIONS IN THIS REVIEW:
${coveredDimensions.length ? JSON.stringify(coveredDimensions) : "None"}

For a NEW question, select only facts or relationships that are not already
represented by the COVERED DIMENSIONS.

The question must clearly and specifically ask about the selected facts or
relationships.

The answer must be sufficient when it correctly demonstrates those selected
facts or relationships. The student must NOT need to list additional related
facts from the BRAIN MATERIAL that the question did not explicitly ask about.

Do not use broad or open-ended wording such as "specific roles", "functions",
"importance", "mechanisms", or "how does X work" unless the question
explicitly identifies the exact facts or relationships being tested.

Do not generate a question that can reasonably be interpreted as requiring
an entire Brain section or every function of a structure.

Do not generate a new question that tests a covered dimension merely by
changing the wording.

Only revisit a covered dimension when the current task is an explicit
retest of an unresolved knowledge gap.

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
${brainMaterial}

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
          reviewScope: scope || null,
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
