import type { VercelRequest, VercelResponse } from "@vercel/node";
import { VaultClient } from "../lib/github.js";
import { checkAuth } from "../lib/auth.js";

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
    typeof req.body?.question === "string" ? req.body.question.trim() : "";

  const studentAnswer =
    typeof req.body?.answer === "string" ? req.body.answer.trim() : "";

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

    const gradeResponse = await fetch(
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
The BRAIN MATERIAL below is the complete answer key for this evaluation.

You may NOT introduce, infer, assume, or grade against any scientific fact,
mechanism, relationship, terminology, or inverse relationship that is not
explicitly supported by the BRAIN MATERIAL.

If something may be scientifically true but is not explicitly supported by
the BRAIN MATERIAL, do not use it in grading, explanation, repair, or retest.

BRAIN MATERIAL:
${file.content}

QUESTION:
${question}

STUDENT ANSWER:
${studentAnswer}

GRADE USING THIS EXACT RUBRIC:

MASTERED:
All important claims required by the source-supported question are correct.
No material misconception is present.

PARTIAL:
At least one important required component is correct, but another required
component is incorrect or missing.

INCORRECT:
The response contains no substantively correct required component, or its
overall reasoning demonstrates a fundamentally incorrect model without a
correct required component.

MISSING:
The student provides no meaningful answer or insufficient information to
evaluate the required concepts.

Return exactly these sections:

RESULT:
Choose exactly one: MASTERED, PARTIAL, INCORRECT, or MISSING

WHAT WAS RIGHT:
List only correct claims explicitly supported by the BRAIN MATERIAL.

WHAT WAS WRONG OR MISSING:
Identify every required error or omission using only the BRAIN MATERIAL.

WHY IT WAS WRONG:
Explain the discrepancy between the student's answer and the BRAIN MATERIAL.
Do not introduce outside mechanisms or facts.

REPAIR:
Reconstruct the answer to the QUESTION using only the BRAIN MATERIAL.

The repair must directly address every important component of the QUESTION
that the student got wrong or missed.

Do not merely list isolated facts. State the relevant relationships between
the facts when those relationships are explicitly supported by the
BRAIN MATERIAL.

Use source-specific wording. Do not convert a specific relationship in the
BRAIN MATERIAL into a broader scientific rule or principle unless that broader
rule is itself explicitly stated in the BRAIN MATERIAL.

Keep the repair concise and focused on the student's actual knowledge gap.

RETEST QUESTION:
Ask a different free-recall question that targets the same failed or
incomplete concept from the original QUESTION.

The retest must directly test the specific information or relationship that
the student got wrong or failed to provide.

The retest must preserve the same conceptual target as the original QUESTION.
It may change the wording or structure, but it must require retrieval of the
same missing or incorrect knowledge.

Do not switch to an adjacent concept merely because it appears elsewhere in
the BRAIN MATERIAL.

Do not broaden the question beyond the original knowledge gap.

STRICT RETEST GROUNDING:
Every scientific condition, relationship, mechanism, descriptor, and piece of
context used in the retest question must be explicitly supported by the
BRAIN MATERIAL.

The retest may reorganize or combine Brain-supported facts, but it must not
add scientific information or introduce a new concept.

Do not ask the student to derive or state a general scientific rule from a
specific example or comparison unless that general rule is explicitly stated
in the BRAIN MATERIAL.

Do not provide the answer.

GROUNDING CHECK:
List any scientific claim in your evaluation that is NOT explicitly supported
by the BRAIN MATERIAL. If there are none, write exactly: NONE`,
            },
          ],
        }),
      }
    );

      const gradeData = await gradeResponse.json();

    if (!gradeResponse.ok) {
      return res.status(gradeResponse.status).json({
        error: "AI Gateway grading request failed",
        details: gradeData,
      });
    }

    const evaluation =
      gradeData?.choices?.[0]?.message?.content?.trim();

    if (!evaluation) {
      return res.status(500).json({
        error: "Grader returned no evaluation",
      });
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

QUESTION:
${question}

STUDENT ANSWER:
${studentAnswer}

GRADER EVALUATION:
${evaluation}

Determine whether every scientific claim, correction, explanation, repair,
and retest condition in the GRADER EVALUATION is explicitly supported by
the BRAIN MATERIAL.

Also determine whether the RETEST QUESTION directly targets the same failed
or incomplete concept identified by the GRADER EVALUATION and required by
the original QUESTION.

The retest must test the student's actual knowledge gap, not merely another
fact that happens to appear in the BRAIN MATERIAL.

Do not approve a retest that switches to an adjacent concept.

Do not use outside knowledge.
Do not infer unstated scientific relationships.

The grader may identify that the student omitted, contradicted, or correctly
stated information only when that judgment is supported by the BRAIN MATERIAL.

If the entire evaluation is grounded in the BRAIN MATERIAL AND the retest
directly targets the identified knowledge gap, reply exactly:
SUPPORTED

If any scientific claim, explanation, repair, or retest requires information
not explicitly present in the BRAIN MATERIAL, or if the retest does not
directly target the identified knowledge gap, reply:
UNSUPPORTED: followed by a brief description of the problem.

Return nothing else.`,
            },
          ],
        }),
      }
    );

    const verifyData = await verifyResponse.json();

    if (!verifyResponse.ok) {
      return res.status(verifyResponse.status).json({
        error: "AI Gateway grading verification request failed",
        details: verifyData,
      });
    }

    const verification =
      verifyData?.choices?.[0]?.message?.content?.trim() ?? "";

    if (verification !== "SUPPORTED") {
      return res.status(422).json({
        success: false,
        blocked: true,
        source: "study/mcat-bbfl.md",
        question,
        answer: studentAnswer,
        evaluation,
        verification,
        gradingUsage: gradeData?.usage ?? null,
        verificationUsage: verifyData?.usage ?? null,
      });
    }

    return res.status(200).json({
      success: true,
      source: "study/mcat-bbfl.md",
      question,
      answer: studentAnswer,
      evaluation,
      verification: "SUPPORTED",
      gradingUsage: gradeData?.usage ?? null,
      verificationUsage: verifyData?.usage ?? null,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
