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

// --- Covered-dimension collision gate ---------------------------------------
// Prevents a NEW question from re-testing a knowledge dimension the student has
// already mastered. Two layers: a cheap deterministic keyword pre-check, then a
// single yes/no model backstop for paraphrase the keyword check would miss.

const DIMENSION_STOPWORDS = new Set([
  "the", "and", "of", "a", "an", "to", "in", "on", "for", "with", "its",
  "is", "are", "was", "were", "be", "by", "as", "at", "or", "that", "this",
  "which", "what", "how", "does", "do", "between", "into", "from", "their",
  "role", "roles", "function", "functions", "type", "types", "context",
  "specific", "component", "components", "relationship", "relationships",
]);

function dimensionTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 2 && !DIMENSION_STOPWORDS.has(t))
  );
}

// True when the candidate shares enough significant tokens with any covered
// dimension to be considered the same cluster.
function keywordCollision(
  candidateLabel: string,
  covered: string[]
): boolean {
  const cand = dimensionTokens(candidateLabel);
  if (cand.size === 0) return false;

  for (const entry of covered) {
    const prev = dimensionTokens(entry);
    if (prev.size === 0) continue;

    let shared = 0;
    for (const t of cand) if (prev.has(t)) shared++;

    const smaller = Math.min(cand.size, prev.size);
    // Same cluster if the majority of the smaller token set overlaps.
    if (smaller > 0 && shared / smaller >= 0.5) return true;
  }

  return false;
}

// Model backstop: asks the model whether the candidate tests the same cluster
// as any covered dimension. Returns true on COVERED, false on NEW. On any
// error or ambiguous reply it returns false (fail-open — never dead-end a
// session over a dedup check).
async function modelCollision(
  aiKey: string,
  candidateLabel: string,
  candidateQuestion: string,
  covered: string[]
): Promise<boolean> {
  const prompt = `You are a knowledge-dimension deduplication check.

COVERED DIMENSIONS (already mastered by the student):
${JSON.stringify(covered)}

CANDIDATE QUESTION:
${candidateQuestion}

CANDIDATE DIMENSION LABEL:
${candidateLabel}

Decide whether the CANDIDATE tests the SAME underlying knowledge cluster as any
COVERED DIMENSION — i.e. the same facts or relationship, even if the wording,
ordering, or framing differs.

Testing the same cluster from a different angle still counts as COVERED.
Only reply NEW if the candidate tests a genuinely different fact or
relationship not represented in the covered list.

Reply with exactly one word: COVERED or NEW. Return nothing else.`;

  try {
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
          messages: [{ role: "user", content: prompt }],
        }),
      }
    );

    if (!response.ok) return false;

    const data = await response.json();
    const reply =
      data?.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";

    return reply.startsWith("COVERED");
  } catch {
    return false;
  }
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

    let lastSupported:
      | {
          question: string;
          dimensionId: string;
          dimensionLabel: string;
          attempt: number;
        }
      | null = null;

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

Return ONLY valid JSON with exactly this shape:

{
  "question": "...",
  "dimensionId": "...",
  "dimensionLabel": "..."
}

The dimensionId must be a stable, concise identifier for the specific
knowledge dimension tested by this question.

Use lowercase snake_case.

The dimensionLabel must briefly describe the exact knowledge dimension
tested by the question.

If a semantically identical dimension already appears in the COVERED
DIMENSIONS, do not select it for a NEW question.

If a dimension is not covered, use the same dimensionId consistently for that
dimension whenever it is referenced again.`,
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

     const generatedContent =
  generationData?.choices?.[0]?.message?.content?.trim();

let generatedQuestion: {
  question: string;
  dimensionId: string;
  dimensionLabel: string;
} | null = null;

try {
  const parsed = JSON.parse(generatedContent ?? "");

  if (
    typeof parsed?.question === "string" &&
    typeof parsed?.dimensionId === "string" &&
    typeof parsed?.dimensionLabel === "string"
  ) {
    generatedQuestion = parsed;
  }
} catch {
  generatedQuestion = null;
}

const question = generatedQuestion?.question?.trim() ?? "";
const dimensionId = generatedQuestion?.dimensionId?.trim() ?? "";
const dimensionLabel = generatedQuestion?.dimensionLabel?.trim() ?? "";

     if (!question || !dimensionId || !dimensionLabel) {
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
        // Collision gate: reject a supported question that re-tests an
        // already-mastered dimension. Only runs when something is covered.
        if (coveredDimensions.length > 0) {
          const collided =
            keywordCollision(dimensionLabel, coveredDimensions) ||
            (await modelCollision(
              aiKey,
              dimensionLabel,
              question,
              coveredDimensions
            ));

          if (collided) {
            // Remember it as a graceful fallback, then regenerate.
            lastSupported = {
              question,
              dimensionId,
              dimensionLabel,
              attempt,
            };
            attempts.push({
              attempt,
              question,
              verification: "SUPPORTED_BUT_COVERED",
              generationUsage: generationData?.usage ?? null,
              verificationUsage: verifyData?.usage ?? null,
            });
            continue;
          }
        }

        return res.status(200).json({
          success: true,
          source: "study/mcat-bbfl.md",
          reviewScope: scope || null,
          question,
          dimensionId,
          dimensionLabel,
          verification: "SUPPORTED",
          attempt,
          attempts,
        });
      }
    }

    // Every attempt either failed verification or collided with a covered
    // dimension. If at least one was grounded-but-covered, surface it rather
    // than dead-ending the session (repeats are better than a hard stop).
    if (lastSupported) {
      return res.status(200).json({
        success: true,
        source: "study/mcat-bbfl.md",
        reviewScope: scope || null,
        question: lastSupported.question,
        dimensionId: lastSupported.dimensionId,
        dimensionLabel: lastSupported.dimensionLabel,
        verification: "SUPPORTED",
        coveredFallback: true,
        attempt: lastSupported.attempt,
        attempts,
      });
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
