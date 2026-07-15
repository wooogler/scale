import { z } from 'zod';

/** A top-level feature group. UI skin: "province". */
export const ProvinceSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type Province = z.infer<typeof ProvinceSchema>;

/**
 * A component's spatial placement on the frozen map.
 * Coordinates are normalized to [0,1]; importance drives node size and
 * unification weighting.
 */
export const MapNodeSchema = z.object({
  id: z.string(),
  province: z.string(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  importance: z.number().min(0).max(1),
});
export type MapNode = z.infer<typeof MapNodeSchema>;

/** Edge kind between components. */
export const MapEdgeKindSchema = z.enum(['hierarchy', 'reference', 'depends_on']);
export type MapEdgeKind = z.infer<typeof MapEdgeKindSchema>;

export const MapEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: MapEdgeKindSchema,
});
export type MapEdge = z.infer<typeof MapEdgeSchema>;

/** The frozen spatial layout artifact (`.scale/map.json`). */
export const MapJsonSchema = z.object({
  version: z.number(),
  builtFromSha: z.string(),
  provinces: z.array(ProvinceSchema),
  nodes: z.array(MapNodeSchema),
  edges: z.array(MapEdgeSchema),
});
export type MapJson = z.infer<typeof MapJsonSchema>;
