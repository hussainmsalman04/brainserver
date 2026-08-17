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
    content: `You are an MCAT active-recall examiner.

SOURCE MATERIAL:
PFK-1 (phosphofructokinase-1) is the rate-limiting enzyme of glycolysis.
PFK-1 is activated by AMP and fructose-2,6-bisphosphate (F2,6BP).
PFK-1 is inhibited by ATP and citrate.

QUESTION:
If a cell is experiencing a high-energy state characterized by an abundance of ATP and a surplus of citric acid cycle intermediates, how would the activity of the glycolysis pathway be modulated, and which specific enzyme serves as the control point for this regulation?

STUDENT ANSWER:
Glycolysis would increase because the cell has lots of ATP available. PFK-1 is the main regulatory enzyme.

Grade the student's answer using ONLY the source material.

Return these sections:

RESULT:
Choose exactly one: MASTERED, PARTIAL, INCORRECT, or MISSING

WHAT WAS RIGHT:
Identify the correct parts of the student's answer.

WHAT WAS WRONG OR MISSING:
Identify every important error or omission.

WHY IT WAS WRONG:
Explain the conceptual reason for the error, not merely the correct answer.

REPAIR:
Give the minimum information necessary to repair the student's understanding.

RETEST QUESTION:
Ask a different free-recall question testing the same weakness. Do not provide the answer to the retest question.`,
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
