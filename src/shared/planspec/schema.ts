import { z } from 'zod';

/**
 * PlanSpec — the canonical plan format. All three Feature-1 modes (Pro,
 * Creative, Chat) produce a PlanSpec; the workspace loads and saves it.
 * Units: metres. Plan coordinates: x → east, y → south (screen-down).
 */
const Vec2 = z.tuple([z.number(), z.number()]);

export const ROOM_TYPES = [
  'bedroom', 'master', 'bathroom', 'ensuite', 'kitchen', 'living', 'dining', 'study',
  'garage', 'laundry', 'hallway', 'entry', 'stairs', 'wc', 'other',
] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

export const WallSchema = z.object({
  id: z.string(),
  a: Vec2,
  b: Vec2,
  thickness: z.number().positive(),
  exterior: z.boolean(),
});

export const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(ROOM_TYPES),
  polygon: z.array(Vec2),
  area: z.number(),
});

export const OpeningSchema = z.object({
  id: z.string(),
  wallId: z.string(),
  type: z.enum(['door', 'window']),
  /** distance in metres from wall point `a` to the opening centre */
  offset: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
  sill: z.number().optional(),
});

export const FloorSchema = z.object({
  level: z.number().int(),
  height: z.number().positive(),
  walls: z.array(WallSchema),
  rooms: z.array(RoomSchema),
  openings: z.array(OpeningSchema),
});

export const RequirementsSchema = z.object({
  area: z.number(),
  floors: z.number().int(),
  bedrooms: z.number().int(),
  bathrooms: z.number().int(),
  extras: z.array(z.string()),
  style: z.string().optional(),
  notes: z.string(),
});

export const PlanSpecSchema = z.object({
  version: z.literal('1.0'),
  meta: z.object({
    title: z.string(),
    createdBy: z.enum(['client', 'architect']),
    mode: z.enum(['pro', 'creative', 'chat']),
    createdAt: z.string(),
    id: z.string().optional(),
    seed: z.number().optional(),
  }),
  site: z.object({ width: z.number(), depth: z.number(), northAngle: z.number() }).optional(),
  floors: z.array(FloorSchema).min(1),
  requirements: RequirementsSchema.optional(),
});

export type Wall = z.infer<typeof WallSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type Floor = z.infer<typeof FloorSchema>;
export type Requirements = z.infer<typeof RequirementsSchema>;
export type PlanSpec = z.infer<typeof PlanSpecSchema>;

export const ROOM_LABELS: Record<RoomType, string> = {
  bedroom: 'Bedroom', master: 'Main bedroom', bathroom: 'Bathroom', ensuite: 'Ensuite',
  kitchen: 'Kitchen', living: 'Living', dining: 'Dining', study: 'Study', garage: 'Garage',
  laundry: 'Laundry', hallway: 'Hallway', entry: 'Entry', stairs: 'Stairs', wc: 'Toilet', other: 'Room',
};

export const ROOM_COLORS: Record<RoomType, string> = {
  bedroom: '#E9E1F2', master: '#E2D7EF', bathroom: '#D8EAF0', ensuite: '#D8EAF0', kitchen: '#F4E6CF',
  living: '#F3EBDD', dining: '#F1E4D3', study: '#E3ECDD', garage: '#E5E5E3', laundry: '#D9E8EC',
  hallway: '#EFEDE8', entry: '#EFEAE0', stairs: '#E6E2DA', wc: '#D8EAF0', other: '#EEEBE5',
};

export function emptyPlan(mode: PlanSpec['meta']['mode'], title = 'My new home'): PlanSpec {
  return {
    version: '1.0',
    meta: { title, createdBy: 'client', mode, createdAt: new Date().toISOString() },
    site: { width: 20, depth: 30, northAngle: 0 },
    floors: [{ level: 0, height: 2.7, walls: [], rooms: [], openings: [] }],
  };
}
