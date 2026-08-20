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

/**
 * Convert arbitrary concept names into stable map IDs.
 *
 * Example:
 * "Oxidative Phosphorylation" -> "oxidative-phosphorylation"
 */
export function normalizeConceptId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeSource(existing: string, incoming: string): string {
  const oldParts = existing
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);

  const newParts = incoming
    .split("·")
    .map((part) => part.trim())
    .filter(Boolean);

  return uniqueStrings([...oldParts, ...newParts]).join(" · ");
}

function noteSignature(note: ConceptMapNote): string {
  if (note.type === "bullets") {
    return [
      note.type,
      note.title.trim().toLowerCase(),
      ...note.items.map((item) => item.trim().toLowerCase()),
    ].join("|");
  }

  return [
    note.type,
    note.title.trim().toLowerCase(),
    ...note.steps.map((step) => step.trim().toLowerCase()),
  ].join("|");
}

function mergeNotes(
  existing: ConceptMapNote[],
  incoming: ConceptMapNote[]
): ConceptMapNote[] {
  const result = [...existing];
  const seen = new Set(existing.map(noteSignature));

  for (const note of incoming) {
    const signature = noteSignature(note);

    if (seen.has(signature)) {
      continue;
    }

    result.push(note);
    seen.add(signature);
  }

  return result;
}

function cloneMap(data: ConceptMapData): ConceptMapData {
  return JSON.parse(JSON.stringify(data)) as ConceptMapData;
}

function validateNodePatch(
  patch: ConceptMapNodePatch,
  map: ConceptMapData
): string | null {
  const id = normalizeConceptId(patch.id);

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

  const parentId = normalizeConceptId(patch.parent);

  /*
   * Parent may either:
   * 1. already exist in the map, or
   * 2. be another node being introduced by the same patch.
   *
   * The second case is checked later once all incoming IDs are known.
   */
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

/**
 * Safely apply an approved lesson's concept-map patch.
 *
 * Behavior:
 *
 * Existing concept:
 * - preserves the current node
 * - appends new lesson provenance
 * - merges non-duplicate notes
 * - optionally enriches the description
 *
 * New concept:
 * - creates the node
 * - attaches it to its parent
 *
 * This function never deletes nodes.
 * This function never moves an existing node automatically.
 */
export function applyConceptMapPatch(
  current: ConceptMapData,
  patch: ConceptMapPatch
): ConceptMapMergeResult {
  const data = cloneMap(current);

  const addedNodes: string[] = [];
  const enrichedNodes: string[] = [];

  if (!patch || !Array.isArray(patch.nodes)) {
    throw new Error("Concept Map patch must contain a nodes array.");
  }

  const incomingIds = new Set(
    patch.nodes.map((node) => normalizeConceptId(node.id))
  );

  for (const nodePatch of patch.nodes) {
    const error = validateNodePatch(nodePatch, data);

    if (error) {
      throw new Error(error);
    }

    const id = normalizeConceptId(nodePatch.id);
    const parentId = normalizeConceptId(nodePatch.parent);

    if (!data[parentId] && !incomingIds.has(parentId)) {
      throw new Error(
        `Concept Map parent "${parentId}" does not exist for "${id}".`
      );
    }
  }

  /*
   * We may receive parent + child in the same patch.
   * Process repeatedly until every node whose parent is available
   * has been merged.
   */
  const pending = [...patch.nodes];

  let safetyCounter = 0;

  while (pending.length > 0) {
    safetyCounter += 1;

    if (safetyCounter > patch.nodes.length + 5) {
      throw new Error(
        "Concept Map patch contains an unresolved parent relationship."
      );
    }

    let progressed = false;

    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const nodePatch = pending[index];

      const id = normalizeConceptId(nodePatch.id);
      const parentId = normalizeConceptId(nodePatch.parent);

      if (!data[parentId]) {
        continue;
      }

      const existing = data[id];

      if (existing) {
        /*
         * Important safety rule:
         *
         * We do NOT automatically re-parent an existing concept.
         * If later semantic review decides a concept belongs elsewhere,
         * that should be an explicit reviewed structural change.
         */
        if (existing.parent !== parentId) {
          throw new Error(
            `Concept "${id}" already exists under "${existing.parent}" and cannot be automatically moved to "${parentId}".`
          );
        }

        existing.source = mergeSource(
          existing.source,
          nodePatch.source
        );

        existing.notes = mergeNotes(
          existing.notes ?? [],
          nodePatch.notes ?? []
        );

        if (
          nodePatch.desc &&
          nodePatch.desc.trim() &&
          nodePatch.desc.trim() !== existing.desc.trim()
        ) {
          /*
           * Keep the existing approved description as the anchor.
           * Add genuinely new summary information instead of replacing it.
           */
          const incomingDescription = nodePatch.desc.trim();

          if (!existing.desc.includes(incomingDescription)) {
            existing.desc =
              `${existing.desc.trim()} ${incomingDescription}`.trim();
          }
        }

        if (
          nodePatch.status &&
          nodePatch.status !== existing.status
        ) {
          existing.status = nodePatch.status;
        }

        enrichedNodes.push(id);
      } else {
        data[id] = {
          title: nodePatch.title.trim(),
          parent: parentId,
          source: nodePatch.source.trim(),
          status: nodePatch.status ?? "",
          desc:
            nodePatch.desc?.trim() ||
            `${nodePatch.title.trim()} from the material learned so far.`,
          children: [],
          notes: nodePatch.notes ?? [],
        };

        addedNodes.push(id);
      }

      const parent = data[parentId];

      if (!parent.children.includes(id)) {
        parent.children.push(id);
      }

      pending.splice(index, 1);
      progressed = true;
    }

    if (!progressed && pending.length > 0) {
      const unresolved = pending
        .map(
          (node) =>
            `${normalizeConceptId(node.id)} -> ${normalizeConceptId(
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
    addedNodes: uniqueStrings(addedNodes),
    enrichedNodes: uniqueStrings(enrichedNodes),
  };
}
