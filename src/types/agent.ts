/**
 * Opaque model type — hides SDK details from upper layers.
 *
 * Only `model-factory.ts` (creation) and `BaseAgent.streamLoop` (usage)
 * know the concrete SDK type. All other code uses this abstraction.
 */
export type WayangLanguageModel = object;
