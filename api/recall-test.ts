import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
) {
  const apiKey = process.env.AI_GATEWAY_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "AI_GATEWAY_API_KEY is missing",
    });
  }

  try {
    const response = await fetch(
      "https://ai-gateway.vercel.sh/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3.1-flash-lite",
      messages: [
  {
    role: "user",
    content: `You are an evidence-bound MCAT active-recall examiner.

STRICT GROUNDING RULE:
The SOURCE MATERIAL below is the complete answer key for this evaluation.

You may NOT introduce, infer, assume, or grade against any scientific fact,
mechanism, relationship, terminology, or inverse relationship that is not
explicitly stated in the SOURCE MATERIAL.

If something may be scientifically true but is not explicitly supported by
the SOURCE MATERIAL, do not use it in grading, explanation, repair, or retest.

SOURCE MATERIAL:
PFK-1 (phosphofructokinase-1) is the rate-limiting enzyme of glycolysis.
PFK-1 is activated by AMP and fructose-2,6-bisphosphate (F2,6BP).
PFK-1 is inhibited by ATP and citrate.

QUESTION:
A cell contains high levels of ATP and citrate. Based only on the source
material, what happens to PFK-1, and what role does PFK-1 have in glycolysis?

STUDENT ANSWERS TO GRADE:

ANSWER A:
PFK-1 is inhibited by ATP and citrate. PFK-1 is the rate-limiting enzyme
of glycolysis.

ANSWER B:
PFK-1 is inhibited.

ANSWER C:
PFK-1 is activated by ATP and citrate.

ANSWER D:
I'm not sure.

Grade EACH answer independently using the exact rubric below.

EXPECTED RUBRIC:

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

For EACH answer return:

ANSWER:
A, B, C, or D

RESULT:
Choose exactly one: MASTERED, PARTIAL, INCORRECT, or MISSING

WHAT WAS RIGHT:
Only source-supported correct components.

WHAT WAS WRONG OR MISSING:
Only source-supported errors or omissions.

REPAIR:
Only the minimum source-supported repair.

After grading all four answers return:

GROUNDING CHECK:
List any scientific claim in your evaluation that is not explicitly
supported by the SOURCE MATERIAL. If there are none, write exactly: NONE`
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
      response: data?.choices?.[0]?.message?.content,
      usage: data?.usage ?? null,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unexpected error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
