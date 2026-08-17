import type { VercelRequest, VercelResponse } from "@vercel/node";
import { VaultClient } from "../lib/github.js";
import { checkAuth } from "../lib/auth.js";

const MODEL = "google/gemini-3.1-flash-lite";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const MAX_RETEST_ATTEMPTS = 3;

type GradeResult = {
  result: "MASTERED" | "PARTIAL" | "INCORRECT" | "MISSING";
  whatWasRight: string[];
  whatWasWrongOrMissing: string[];
  whyItWasWrong: string;
  repair: string;
  knowledgeGap: string[];
  requiredDimensions: string[];
};

type RetestCandidate = {
  question: string;
  dimensions: string[];
};

async function callGateway(apiKey: string, prompt: string) {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "AI Gateway request failed"
    );
  }

  const content = data?.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error("AI Gateway returned no content");
  }

  return {
    content,
    usage: data?.usage ?? null,
  };
}

function parseJsonObject<T>(text: string): T {
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  return JSON.parse(cleaned) as T;
}

function normalizeDimension(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasAllRequiredDimensions(
  required: string[],
  candidate: string[]
): boolean {
  const requiredSet = new Set(required.map(normalizeDimension));
  const candidateSet = new Set(candidate.map(normalizeDimension));

  if (requiredSet.size !== candidateSet.size) {
    return false;
  }

  return [...requiredSet].every((dimension) =>
    candidateSet.has(dimension)
  );
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  if (req.method !== "POST") {
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

        const question =
        typeof req.body?.question === "string"
          ? req.body.question.trim()
          : "";

      const studentAnswer =
        typeof req.body?.answer === "string"
          ? req.body.answer.trim()
          : "";

      const incomingReviewState =
        req.body?.reviewState &&
        typeof req.body.reviewState === "object"
          ? req.body.reviewState
          : null;

      const reviewState = {
        originalQuestion:
          typeof incomingReviewState?.originalQuestion === "string"
            ? incomingReviewState.originalQuestion.trim()
            : question,

        requiredDimensions:
          Array.isArray(incomingReviewState?.requiredDimensions)
            ? incomingReviewState.requiredDimensions.filter(
                (item: unknown): item is string =>
                  typeof item === "string" && item.trim().length > 0
              )
            : [],

        knowledgeGap:
          Array.isArray(incomingReviewState?.knowledgeGap)
            ? incomingReviewState.knowledgeGap.filter(
                (item: unknown): item is string =>
                  typeof item === "string" && item.trim().length > 0
              )
            : [],

        retestNumber:
          typeof incomingReviewState?.retestNumber === "number" &&
          Number.isInteger(incomingReviewState.retestNumber)
            ? incomingReviewState.retestNumber
            : 0,
      };
  if (!question) {
    return res.status(400).json({
      error: "question is required",
    });
  }

  if (!studentAnswer) {
    return res.status(400).json({
      error: "answer is required",
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

    const gradePrompt = `You are an evidence-bound MCAT active-recall examiner.

The BRAIN MATERIAL below is the complete source for this evaluation.
Do not introduce or rely on scientific information that is not explicitly
supported by the BRAIN MATERIAL.

BRAIN MATERIAL:
${file.content}

QUESTION:
${question}

STUDENT ANSWER:
${studentAnswer}

REVIEW SESSION:
This may be either a new review or a continuation of an existing review
session.

ORIGINAL QUESTION:
${reviewState.originalQuestion}

REQUIRED DIMENSIONS FROM THE ORIGINAL REVIEW:
${JSON.stringify(reviewState.requiredDimensions)}

PREVIOUS KNOWLEDGE GAP:
${JSON.stringify(reviewState.knowledgeGap)}

CURRENT RETEST NUMBER:
${reviewState.retestNumber}

Determine the student's result using this rubric:

MASTERED = all important source-supported components are correct and no
material misconception is present.

PARTIAL = at least one important required component is correct, but another
required component is incorrect or missing.

INCORRECT = no substantively correct required component is present, or the
overall answer demonstrates a fundamentally incorrect model without a correct
required component.

MISSING = no meaningful answer was provided.

Identify the student's current unresolved knowledge gap.

If CURRENT RETEST NUMBER is 0, identify the complete set of required concepts
or comparison dimensions from the QUESTION that the student did not
successfully demonstrate.

If CURRENT RETEST NUMBER is greater than 0, treat PREVIOUS KNOWLEDGE GAP as
the authoritative starting point for the current evaluation.

For a retest, do not restart the knowledge-gap analysis from scratch.

Evaluate whether the student has now demonstrated each item in the PREVIOUS
KNOWLEDGE GAP.

If the student successfully demonstrates an item from the PREVIOUS KNOWLEDGE
GAP, remove that item from the new knowledgeGap.

If the student still fails to demonstrate an item, keep that item in the new
knowledgeGap.

Do not re-add a concept that was already demonstrated and is no longer part
of the unresolved gap.

If the student has successfully demonstrated every unresolved component,
return MASTERED and an empty knowledgeGap and requiredDimensions array.

For requiredDimensions, list only the dimensions that remain unresolved after
evaluating the current answer.

Return ONLY valid JSON with exactly this shape:

{
  "result": "MASTERED | PARTIAL | INCORRECT | MISSING",
  "whatWasRight": ["..."],
  "whatWasWrongOrMissing": ["..."],
  "whyItWasWrong": "...",
  "repair": "...",
  "knowledgeGap": ["..."],
  "requiredDimensions": ["..."]
}

Rules:
- Every scientific claim must be supported by the BRAIN MATERIAL.
- Repair must reconstruct the student's actual missing or incorrect knowledge.
- Do not generalize a specific Brain relationship into a broader scientific
  rule unless that broader rule is explicitly stated in the Brain.
- On a new review where CURRENT RETEST NUMBER is 0, requiredDimensions must
  contain the required dimensions from the original QUESTION that the student
  did not successfully demonstrate.

- On a retest where CURRENT RETEST NUMBER is greater than 0,
  requiredDimensions must contain only the dimensions that remain unresolved
  from the PREVIOUS KNOWLEDGE GAP.

- Never restore a previously resolved dimension merely because it was part of
  the original QUESTION.

- If the student is MASTERED, knowledgeGap and requiredDimensions must both be
  empty arrays.

- - Do not generate a retest question yet.`;
    const grade = await callGateway(aiKey, gradePrompt);
    const gradeResult = parseJsonObject<GradeResult>(grade.content);

    const validResults = new Set([
      "MASTERED",
      "PARTIAL",
      "INCORRECT",
      "MISSING",
    ]);

    if (!validResults.has(gradeResult.result)) {
      return res.status(502).json({
        error: "Grader returned an invalid result",
        raw: grade.content,
      });
    }

    if (
      !Array.isArray(gradeResult.requiredDimensions) ||
      !Array.isArray(gradeResult.knowledgeGap)
    ) {
      return res.status(502).json({
        error: "Grader returned invalid dimension data",
        raw: grade.content,
      });
    }

         if (gradeResult.result === "MASTERED") {
        return res.status(200).json({
          success: true,
          source: "study/mcat-bbfl.md",
          question,
          answer: studentAnswer,
          evaluation: {
            ...gradeResult,
            retestQuestion: "",
          },
          verification: "SUPPORTED",
          gradingUsage: grade.usage,
          verificationUsage: null,
          retestAttempts: 0,
          reviewState: {
            originalQuestion: reviewState.originalQuestion,
            requiredDimensions: [],
            knowledgeGap: [],
            retestNumber: reviewState.retestNumber,
            mastered: true,
          },
        });
      }

      if (reviewState.retestNumber >= 3) {
        return res.status(422).json({
          success: false,
          blocked: true,
          source: "study/mcat-bbfl.md",
          question,
          answer: studentAnswer,
          evaluation: gradeResult,
          error: "Review reached the maximum of 3 retests.",
          reviewState: {
            originalQuestion: reviewState.originalQuestion,
            requiredDimensions: gradeResult.requiredDimensions,
            knowledgeGap: gradeResult.knowledgeGap,
            retestNumber: reviewState.retestNumber,
            mastered: false,
          },
          gradingUsage: grade.usage,
        });
      }

      if (gradeResult.requiredDimensions.length === 0) {
        return res.status(502).json({
          error: "Grader did not identify a required knowledge gap",
        });
      }
      
    const attempts: Array<{
      attempt: number;
      question: string;
      dimensions: string[];
      dimensionCheck: "PASS" | "FAIL";
      verification: string;
      generationUsage: unknown;
      verificationUsage: unknown;
    }> = [];

    let totalVerificationUsage: unknown = null;

    for (let attempt = 1; attempt <= MAX_RETEST_ATTEMPTS; attempt++) {
      const retestPrompt = `You are an MCAT retest-question generator.

BRAIN MATERIAL:
${file.content}

ORIGINAL QUESTION:
${reviewState.originalQuestion}

ORIGINAL REQUIRED DIMENSIONS:
${JSON.stringify(reviewState.requiredDimensions)}

CURRENT RETEST NUMBER:
${reviewState.retestNumber}

CURRENT REMAINING KNOWLEDGE GAP:
${JSON.stringify(gradeResult.knowledgeGap)}

CURRENT REMAINING REQUIRED DIMENSIONS:
${JSON.stringify(gradeResult.requiredDimensions)}

Generate ONE different free-recall retest question.

The retest must directly target the CURRENT REMAINING KNOWLEDGE GAP.

The retest must test EXACTLY the CURRENT REMAINING REQUIRED DIMENSIONS.
Do not test additional dimensions.

The retest must preserve the same named concepts, entities, and comparison
relationship required by the ORIGINAL QUESTION.

The ORIGINAL QUESTION is the authoritative conceptual anchor for the entire
Review session.

Do not use the current question as the conceptual source for the retest.

A different retrieval angle means different wording, ordering, or recall
framing of the SAME source-supported relationship.

Do not introduce a new physiological setting, location, condition, mechanism,
role, implication, or contextual scenario merely to make the retest different.

Do not introduce a broader category or adjacent concept merely because it
appears elsewhere in the BRAIN MATERIAL.

Do not add context that is not necessary to test the CURRENT REMAINING
REQUIRED DIMENSIONS.

If the BRAIN MATERIAL supports only a narrow set of facts for the remaining
gap, keep the retest narrow. A concise rephrasing of the same comparison is
preferred over adding new context.

Every scientific claim and every piece of contextual framing must be explicitly
supported by the BRAIN MATERIAL AND directly relevant to the ORIGINAL QUESTION
or CURRENT REMAINING KNOWLEDGE GAP.

Do not turn a specific Brain-supported relationship into a broader scientific
rule.

Do not invent a new retrieval context simply because the question must be
different from a previous retest.
  
Return ONLY valid JSON with exactly this shape:

{
  "question": "...",
  "dimensions": ["...", "..."]
}

The dimensions array must list every CURRENT REMAINING REQUIRED DIMENSION
that the question actually tests. Do not include dimensions that the question
does not test, and do not add dimensions that have already been resolved.`;

      let retest: RetestCandidate;
      let generationUsage: unknown = null;

      try {
        const generated = await callGateway(aiKey, retestPrompt);
        generationUsage = generated.usage;
        retest = parseJsonObject<RetestCandidate>(generated.content);
      } catch (error) {
        attempts.push({
          attempt,
          question: "",
          dimensions: [],
          dimensionCheck: "FAIL",
          verification:
            error instanceof Error ? error.message : String(error),
          generationUsage,
          verificationUsage: null,
        });
        continue;
      }

      if (
        typeof retest.question !== "string" ||
        !retest.question.trim() ||
        !Array.isArray(retest.dimensions)
      ) {
        attempts.push({
          attempt,
          question: "",
          dimensions: [],
          dimensionCheck: "FAIL",
          verification: "Invalid retest structure",
          generationUsage,
          verificationUsage: null,
        });
        continue;
      }

      const dimensionCheck = hasAllRequiredDimensions(
        gradeResult.requiredDimensions,
        retest.dimensions
      );

      if (!dimensionCheck) {
        attempts.push({
          attempt,
          question: retest.question,
          dimensions: retest.dimensions,
          dimensionCheck: "FAIL",
          verification: "Required dimensions missing",
          generationUsage,
          verificationUsage: null,
        });
        continue;
      }

        const verifierPrompt = `You are the final evidence and targeting verifier.

BRAIN MATERIAL:
${file.content}

ORIGINAL QUESTION:
${reviewState.originalQuestion}

ORIGINAL REQUIRED DIMENSIONS:
${JSON.stringify(reviewState.requiredDimensions)}

CURRENT REMAINING KNOWLEDGE GAP:
${JSON.stringify(gradeResult.knowledgeGap)}

CURRENT REMAINING REQUIRED DIMENSIONS:
${JSON.stringify(gradeResult.requiredDimensions)}

CANDIDATE RETEST QUESTION:
${retest.question}

CANDIDATE RETEST DIMENSIONS:
${JSON.stringify(retest.dimensions)}

Verify ALL of the following conditions.

1. Every scientific claim, relationship, descriptor, and piece of contextual
framing required by the candidate retest is explicitly supported by the BRAIN
MATERIAL.

2. The candidate retest tests EXACTLY the CURRENT REMAINING REQUIRED DIMENSIONS.
It must not drop a required dimension and must not introduce an additional
dimension.

3. The candidate retest directly targets the CURRENT REMAINING KNOWLEDGE GAP.

4. The candidate preserves the same named concepts, entities, and specific
comparison relationship required by the ORIGINAL QUESTION.

5. Every substantive part of the candidate question must be necessary to test
the CURRENT REMAINING KNOWLEDGE GAP or to express the ORIGINAL QUESTION's
specific comparison.

6. A fact being present somewhere in the BRAIN MATERIAL is NOT sufficient
reason to approve its inclusion. Reject a candidate that introduces an
adjacent Brain fact, broader category, physiological setting, mechanism,
context, role, implication, or scenario that is not required by the ORIGINAL
QUESTION or CURRENT REMAINING KNOWLEDGE GAP.

7. A different retrieval angle may change wording, ordering, or recall framing,
but it must not introduce new scientific context merely to make the question
different.

8. If the BRAIN MATERIAL supports only a narrow set of facts for the remaining
gap, a concise rephrasing of that narrow comparison is valid and preferred.
Do not require the retest to introduce additional context.

9. Do not use outside knowledge.

10. Do not infer unstated scientific relationships.

11. Do not transform a specific Brain-supported relationship into a broader
scientific rule.

12. Reject the candidate if it introduces wording such as a metabolic role,
physiological setting, location, condition, mechanism, or implication unless
that information is explicitly required by the ORIGINAL QUESTION or CURRENT
REMAINING KNOWLEDGE GAP.

Reply with exactly:

SUPPORTED

or:

UNSUPPORTED: followed by a brief reason.

Return nothing else.`;

      let verification = "";
      let verificationUsage: unknown = null;

      try {
        const verified = await callGateway(aiKey, verifierPrompt);
        verification = verified.content.trim();
        verificationUsage = verified.usage;
        totalVerificationUsage = verificationUsage;
      } catch (error) {
        verification =
          error instanceof Error ? error.message : String(error);
      }

      attempts.push({
        attempt,
        question: retest.question,
        dimensions: retest.dimensions,
        dimensionCheck: "PASS",
        verification,
        generationUsage,
        verificationUsage,
      });

          if (verification === "SUPPORTED") {
        const nextRetestNumber =
          reviewState.retestNumber + 1;

        return res.status(200).json({
          success: true,
          source: "study/mcat-bbfl.md",
          question,
          answer: studentAnswer,
          evaluation: {
            ...gradeResult,
            retestQuestion: retest.question,
          },
          verification: "SUPPORTED",
          gradingUsage: grade.usage,
          verificationUsage: totalVerificationUsage,
          retestAttempts: attempt,
          retestAudit: attempts,
          reviewState: {
            originalQuestion: reviewState.originalQuestion,
            requiredDimensions:
              gradeResult.requiredDimensions,
            knowledgeGap:
              gradeResult.knowledgeGap,
            retestNumber: nextRetestNumber,
            mastered: false,
          },
        });
     }

    }

    return res.status(422).json({
      success: false,
      blocked: true,
      source: "study/mcat-bbfl.md",
      question,
      answer: studentAnswer,
      evaluation: gradeResult,
      error:
        "No retest passed dimension and grounding verification after 3 attempts",
      retestAudit: attempts,
      gradingUsage: grade.usage,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
