import { z } from 'zod';
import { DimNameSchema } from './evidence.js';

export const QuestModalitySchema = z.enum(['quiz', 'socratic']);
export type QuestModality = z.infer<typeof QuestModalitySchema>;

/**
 * Where a quest came from. `drift` was spelled `rebellion` — a UI skin word that
 * had leaked into a schema enum, which PLAN §1-1 forbids; nothing ever produced
 * it, but an old quests.json could carry it, so it migrates rather than failing.
 */
export const QuestOriginSchema = z.preprocess(
  (v) => (v === 'rebellion' ? 'drift' : v),
  z.enum(['session', 'drift', 'voluntary']),
);
export type QuestOrigin = z.infer<typeof QuestOriginSchema>;

export const QuestStatusSchema = z.enum(['pending', 'completed', 'skipped']);
export type QuestStatus = z.infer<typeof QuestStatusSchema>;

/**
 * A single quest item. Permissive/passthrough: the tutor generates items whose
 * exact shape varies by modality; the state engine only relies on `prompt`.
 */
export const QuestItemSchema = z
  .object({
    prompt: z.string(),
    dim: DimNameSchema.optional(),
    answer: z.unknown().optional(),
    options: z.array(z.string()).optional(),
  })
  .passthrough();
export type QuestItem = z.infer<typeof QuestItemSchema>;

export const QuestSchema = z.object({
  id: z.string(),
  componentId: z.string(),
  modality: QuestModalitySchema,
  items: z.array(QuestItemSchema),
  origin: QuestOriginSchema,
  status: QuestStatusSchema,
});
export type Quest = z.infer<typeof QuestSchema>;
