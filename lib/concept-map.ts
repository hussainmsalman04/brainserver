import { VaultClient } from "./github.js";

export type ConceptMapNote =
  | {
      type: "bullets";
      title: string;
      items: string[];
    }
  | {
      type: "path";
      title: string;
      steps: string[];
    };

export type ConceptMapNode = {
  title: string;
  parent: string | null;
  source: string;
  status: "" | "mastered" | "developing";
  desc: string;
  children: string[];
  notes: ConceptMapNote[];
};

export type ConceptMapData = Record<string, ConceptMapNode>;

export type ConceptMapNodePatch = {
  id: string;
  title: string;
  parent: string;
  source: string;
  desc?: string;
  status?: "" | "mastered" | "developing";
  notes?: ConceptMapNote[];
};

export type ConceptMapPatch = {
  nodes: ConceptMapNodePatch[];
};

export type ConceptMapMergeResult = {
  data: ConceptMapData;
  addedNodes: string[];
  enrichedNodes: string[];
};

export type ConceptMapUpdateResult = {
  commitSha: string;
  addedNodes: string[];
  enrichedNodes: string[];
};

const CONCEPT_MAP_PATH = "public/concept-map-data.json";

export function normalizeConceptId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean)
    ),
  ];
}

function mergeSource(
  existing: string,
  incoming: string
): string {
  const oldParts = existing
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);

  const newParts = incoming
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);

  return uniqueStrings([
    ...oldParts,
    ...newParts,
  ]).join(" · ");
}

function noteSignature(
  note: ConceptMapNote
): string {
  if (note.type === "bullets") {
    return [
      note.type,
      note.title.trim().toLowerCase(),
      ...note.items.map(
        (item) =>
          item.trim().toLowerCase()
      ),
    ].join("|");
  }

  return [
    note.type,
    note.title.trim().toLowerCase(),
    ...note.steps.map(
      (step) =>
        step.trim().toLowerCase()
    ),
  ].join("|");
}

function mergeNotes(
  existing: ConceptMapNote[],
  incoming: ConceptMapNote[]
): ConceptMapNote[] {
  const result = [...existing];

  const seen = new Set(
    existing.map(noteSignature)
  );

  for (const note of incoming) {
    const signature =
      noteSignature(note);

    if (seen.has(signature)) {
      continue;
    }

    result.push(note);
    seen.add(signature);
  }

  return result;
}

function cloneMap(
  data: ConceptMapData
): ConceptMapData {
  return JSON.parse(
    JSON.stringify(data)
  ) as ConceptMapData;
}

function validateNodePatch(
  patch: ConceptMapNodePatch,
  map: ConceptMapData
): string | null {
  const id =
    normalizeConceptId(patch.id);

  if (!id) {
    return "Concept Map node id is empty.";
  }

  if (!patch.title.trim()) {
    return `Concept Map node "${id}" is missing a title.`;
  }

  if (!patch.parent.trim()) {
    return `Concept Map node "${id}" is missing a parent.`;
  }

  if (!patch.source.trim()) {
    return `Concept Map node "${id}" is missing a lesson source.`;
  }

  const parentId =
    normalizeConceptId(
      patch.parent
    );

  if (id === parentId) {
    return `Concept Map node "${id}" cannot be its own parent.`;
  }

  if (
    patch.status !== undefined &&
    patch.status !== "" &&
    patch.status !== "mastered" &&
    patch.status !== "developing"
  ) {
    return `Concept Map node "${id}" has an invalid status.`;
  }

  if (!map.mcat || !map.living) {
    return "Concept Map is missing required root nodes.";
  }

  return null;
}

export function applyConceptMapPatch(
  current: ConceptMapData,
  patch: ConceptMapPatch
): ConceptMapMergeResult {
  const data =
    cloneMap(current);

  const addedNodes: string[] = [];
  const enrichedNodes: string[] = [];

  if (
    !patch ||
    !Array.isArray(patch.nodes)
  ) {
    throw new Error(
      "Concept Map patch must contain a nodes array."
    );
  }

  const incomingIds =
    new Set(
      patch.nodes.map(
        (node) =>
          normalizeConceptId(
            node.id
          )
      )
    );

  for (const nodePatch of patch.nodes) {
    const error =
      validateNodePatch(
        nodePatch,
        data
      );

    if (error) {
      throw new Error(error);
    }

    const id =
      normalizeConceptId(
        nodePatch.id
      );

    const parentId =
      normalizeConceptId(
        nodePatch.parent
      );

    if (
      !data[parentId] &&
      !incomingIds.has(parentId)
    ) {
      throw new Error(
        `Concept Map parent "${parentId}" does not exist for "${id}".`
      );
    }
  }

  const pending = [
    ...patch.nodes,
  ];

  let safetyCounter = 0;

  while (pending.length > 0) {
    safetyCounter += 1;

    if (
      safetyCounter >
      patch.nodes.length + 5
    ) {
      throw new Error(
        "Concept Map patch contains an unresolved parent relationship."
      );
    }

    let progressed = false;

    for (
      let index =
        pending.length - 1;
      index >= 0;
      index -= 1
    ) {
      const nodePatch =
        pending[index];

      const id =
        normalizeConceptId(
          nodePatch.id
        );

      const parentId =
        normalizeConceptId(
          nodePatch.parent
        );

      if (!data[parentId]) {
        continue;
      }

      const existing =
        data[id];

      if (existing) {
        if (
          existing.parent !==
          parentId
        ) {
          throw new Error(
            `Concept "${id}" already exists under "${existing.parent}" and cannot be automatically moved to "${parentId}".`
          );
        }

        existing.source =
          mergeSource(
            existing.source,
            nodePatch.source
          );

        existing.notes =
          mergeNotes(
            existing.notes ?? [],
            nodePatch.notes ?? []
          );

        if (
          nodePatch.desc &&
          nodePatch.desc.trim() &&
          nodePatch.desc.trim() !==
            existing.desc.trim()
        ) {
          const incomingDescription =
            nodePatch.desc.trim();

          if (
            !existing.desc.includes(
              incomingDescription
            )
          ) {
            existing.desc =
              `${existing.desc.trim()} ${incomingDescription}`.trim();
          }
        }

        if (
          nodePatch.status &&
          nodePatch.status !==
            existing.status
        ) {
          existing.status =
            nodePatch.status;
        }

        enrichedNodes.push(id);
      } else {
        data[id] = {
          title:
            nodePatch.title.trim(),

          parent:
            parentId,

          source:
            nodePatch.source.trim(),

          status:
            nodePatch.status ?? "",

          desc:
            nodePatch.desc?.trim() ||
            `${nodePatch.title.trim()} from the material learned so far.`,

          children: [],

          notes:
            nodePatch.notes ?? [],
        };

        addedNodes.push(id);
      }

      const parent =
        data[parentId];

      if (
        !parent.children.includes(id)
      ) {
        parent.children.push(id);
      }

      pending.splice(index, 1);
      progressed = true;
    }

    if (
      !progressed &&
      pending.length > 0
    ) {
      const unresolved =
        pending
          .map(
            (node) =>
              `${normalizeConceptId(
                node.id
              )} -> ${normalizeConceptId(
                node.parent
              )}`
          )
          .join(", ");

      throw new Error(
        `Concept Map patch has unresolved relationships: ${unresolved}`
      );
    }
  }

  return {
    data,
    addedNodes:
      uniqueStrings(
        addedNodes
      ),

    enrichedNodes:
      uniqueStrings(
        enrichedNodes
      ),
  };
}

function getConceptMapClient():
  VaultClient {
  const token =
    process.env
      .CONCEPT_MAP_GITHUB_TOKEN;

  const owner =
    process.env
      .CONCEPT_MAP_REPO_OWNER;

  const repo =
    process.env
      .CONCEPT_MAP_REPO_NAME;

  const branch =
    process.env
      .CONCEPT_MAP_BRANCH ??
    "main";

  if (!token) {
    throw new Error(
      "CONCEPT_MAP_GITHUB_TOKEN is missing."
    );
  }

  if (!owner) {
    throw new Error(
      "CONCEPT_MAP_REPO_OWNER is missing."
    );
  }

  if (!repo) {
    throw new Error(
      "CONCEPT_MAP_REPO_NAME is missing."
    );
  }

  return new VaultClient(
    token,
    {
      owner,
      repo,
      branch,
    }
  );
}

export async function readConceptMap():
  Promise<ConceptMapData> {
  const client =
    getConceptMapClient();

  const file =
    await client.readFile(
      CONCEPT_MAP_PATH
    );

  if (!file) {
    throw new Error(
      `${CONCEPT_MAP_PATH} does not exist.`
    );
  }

  let parsed: unknown;

  try {
    parsed =
      JSON.parse(
        file.content
      );
  } catch {
    throw new Error(
      `${CONCEPT_MAP_PATH} is not valid JSON.`
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `${CONCEPT_MAP_PATH} has an invalid structure.`
    );
  }

  const map =
    parsed as ConceptMapData;

  if (
    !map.mcat ||
    !map.living
  ) {
    throw new Error(
      "Concept Map is missing required root nodes."
    );
  }

  return map;
}

export async function updateConceptMap(
  patch: ConceptMapPatch,
  commitMessage:
    string =
      "concept-map: grow from approved lesson"
): Promise<ConceptMapUpdateResult> {
  const client =
    getConceptMapClient();

  const current =
    await readConceptMap();

  const merged =
    applyConceptMapPatch(
      current,
      patch
    );

  const serialized =
    `${JSON.stringify(
      merged.data,
      null,
      2
    )}\n`;

  const result =
    await client.writeFile(
      CONCEPT_MAP_PATH,
      serialized,
      commitMessage
    );

  return {
    commitSha:
      result.commitSha,

    addedNodes:
      merged.addedNodes,

    enrichedNodes:
      merged.enrichedNodes,
  };
}
