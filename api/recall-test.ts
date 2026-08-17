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

Using ONLY the source material above, generate ONE free-recall question that tests understanding rather than simple recognition.

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
