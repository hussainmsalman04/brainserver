import type { VercelRequest, VercelResponse } from "@vercel/node";
import { VaultClient } from "../lib/github.js";
import { checkAuth } from "../lib/auth.js";
// --- Scope parsing + section extraction -------------------------------------
// Sections in the vault are keyed by a "Kaplan Bio X.Y" tag in each heading
// (X = chapter, Y = lesson). Scope drives which sections a review draws from:
//   "1.2"        -> just lesson 1.2
//   "1"          -> all of chapter 1
//   "1,2"        -> chapters 1 and 2 (grouped)
//   "1-3"        -> chapters 1 through 3 (grouped range)
//   "1.2,1.3"    -> specific lessons grouped
//   "Kaplan Bio 1.2" -> back-compat, treated as "1.2"
// Empty scope returns the whole file (unchanged behavior).

type ScopeMatcher = {
  chapters: Set<number>; // whole chapters to include
  lessons: Set<string>; // specific "c.l" lessons to include
};

function parseScopeQuery(scope: string): ScopeMatcher | null {
  // Drop any "kaplan bio" label, keep only digits, dot, comma, hyphen.
  const cleaned = scope
    .toLowerCase()
    .replace(/kaplan\s+bio/g, " ")
    .replace(/[^0-9.,\-]/g, " ")
    .trim();

  if (!cleaned) return null;

  const chapters = new Set<number>();
  const lessons = new Set<string>();

  for (const rawToken of cleaned.split(/[,\s]+/)) {
    const token = rawToken.trim();
    if (!token) continue;

    // Range: "1-3" -> whole chapters 1,2,3
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = parseInt(range[1], 10);
      const end = parseInt(range[2], 10);
      if (start <= end) {
        for (let c = start; c <= end; c++) chapters.add(c);
      }
      continue;
    }

    // Specific lesson: "1.2"
    const lesson = token.match(/^(\d+)\.(\d+)$/);
    if (lesson) {
      lessons.add(
        `${parseInt(lesson[1], 10)}.${parseInt(lesson[2], 10)}`
      );
      continue;
    }

    // Whole chapter: "1"
    const chapter = token.match(/^(\d+)$/);
    if (chapter) {
      chapters.add(parseInt(chapter[1], 10));
      continue;
    }
    // Unrecognized token -> ignored
  }

  if (chapters.size === 0 && lessons.size === 0) return null;
  return { chapters, lessons };
}

// Pull the "Kaplan Bio X.Y" tag from a heading, or a "Scope:" line in the body
// as a fallback. Tolerant of parens, colons, date prefixes, etc. Returns the
// normalized "c.l" (no leading zeros) or null when untagged.
function sectionTag(headingText: string, body: string): string | null {
  const fromHeading = headingText.match(/kaplan\s+bio\s+(\d+)\.(\d+)/i);
  if (fromHeading) {
    return `${parseInt(fromHeading[1], 10)}.${parseInt(fromHeading[2], 10)}`;
  }
  const fromScope = body.match(
    /^\s*scope:\s*(?:kaplan\s+bio\s+)?(\d+)\.(\d+)/im
  );
  if (fromScope) {
    return `${parseInt(fromScope[1], 10)}.${parseInt(fromScope[2], 10)}`;
  }
  return null;
}

function tagMatches(tag: string, matcher: ScopeMatcher): boolean {
  if (matcher.lessons.has(tag)) return true;
  const chapter = parseInt(tag.split(".")[0], 10);
  return matcher.chapters.has(chapter);
}

function extractBrainSection(
  content: string,
  scope: string
): string | null {
  if (!scope.trim()) {
    return content;
  }

  const matcher = parseScopeQuery(scope);
  if (!matcher) {
    return null;
  }

  const lines = content.split(/\r?\n/);

  // Index every heading with its level.
  const headings: { index: number; level: number; text: string }[] = [];
  lines.forEach((line, index) => {
    const m = line.match(/^(#+)\s+(.+?)\s*$/);
    if (m) {
      headings.push({ index, level: m[1].length, text: m[2] });
    }
  });

  if (headings.length === 0) {
    return null;
  }

  const matchedBlocks: string[] = [];

  for (let h = 0; h < headings.length; h++) {
    const heading = headings[h];

    // Section runs until the next heading of the same or higher level, so
    // nested sub-headings stay inside their parent section.
    let endIndex = lines.length;
    for (let j = h + 1; j < headings.length; j++) {
      if (headings[j].level <= heading.level) {
        endIndex = headings[j].index;
        break;
      }
    }

    const block = lines.slice(heading.index, endIndex).join("\n");
    const tag = sectionTag(heading.text, block);

    if (tag && tagMatches(tag, matcher)) {
      matchedBlocks.push(block.trim());
    }
  }

  if (matchedBlocks.length === 0) {
    return null;
  }

  return matchedBlocks.join("\n\n").trim();
}

// --- Knowledge-target coverage ---------------------------------------------

type KnowledgeTarget = {
  id: string;
  subtopic: string;
  text: string;
};

function targetId(subtopic: string, text: string): string {
  return `${subtopic}::${text}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function detectKnowledgeTargets(material: string): KnowledgeTarget[] {
  const targets: KnowledgeTarget[] = [];
  let currentSubtopic = "General";

  for (const rawLine of material.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(/^\*\*(.+?):\*\*/);

    if (heading) {
      currentSubtopic = heading[1].trim();

      const remainder = line.slice(heading[0].length).trim();

      if (remainder) {
        targets.push({
          id: targetId(currentSubtopic, remainder),
          subtopic: currentSubtopic,
          text: remainder,
        });
      }

      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const text = line.replace(/^[-*]\s+/, "").trim();

      if (text) {
        targets.push({
          id: targetId(currentSubtopic, text),
          subtopic: currentSubtopic,
          text,
        });
      }
    }
  }

  const seen = new Set<string>();

  return targets.filter((target) => {
    if (seen.has(target.id)) return false;
    seen.add(target.id);
    return true;
  });
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

const askedSubtopicsRaw =
  typeof req.query?.askedSubtopics === "string"
    ? req.query.askedSubtopics.trim()
    : "";

let askedSubtopics: string[] = [];

if (askedSubtopicsRaw) {
  try {
    const parsed = JSON.parse(askedSubtopicsRaw);
    if (Array.isArray(parsed)) {
      askedSubtopics = parsed.filter(
        (s): s is string => typeof s === "string"
      );
    }
  } catch {
    askedSubtopics = [];
  }
}

const subtopics = detectSubtopics(brainMaterial);
const remaining = subtopics.filter((s) => !askedSubtopics.includes(s));

// If the note has detectable subtopics and every one has been asked, the
// review for this scope is finished — stop instead of generating repeats.
if (subtopics.length > 0 && remaining.length === 0) {
  return res.status(200).json({
    success: true,
    sectionComplete: true,
    source: "study/mcat-bbfl.md",
    reviewScope: scope || null,
    subtopics,
    askedCount: askedSubtopics.length,
  });
}

// Target the next uncovered subtopic (note order). Null when the note has no
// detectable subtopics — generation then stays unconstrained.
const targetSubtopic: string | null =
  remaining.length > 0 ? remaining[0] : null;

const targetBlock = targetSubtopic
  ? `\nTARGET SUBTOPIC:\nFocus this question specifically on the subtopic "${targetSubtopic}". Select your one or two facts from within that subtopic's content in the BRAIN MATERIAL. Do not draw the question from a different subtopic.\n`
  : "";

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
${targetBlock}
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
          targetSubtopic,
          subtopics,
          askedCount: askedSubtopics.length,
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
        targetSubtopic,
        subtopics,
        askedCount: askedSubtopics.length,
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
