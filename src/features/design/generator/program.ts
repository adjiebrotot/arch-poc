/**
 * The room programme: which rooms the brief asks for, roughly how big each wants to be, and which
 * floor each goes on. Floor count and floor sizes come from the client's footprints; the programme
 * adapts to them (bedrooms move to the floor with space, spare space becomes a family room or a
 * retreat), never the other way round.
 */
import type { RoomType } from '@shared/planspec/schema';

export interface Brief {
  bedrooms: number;
  bathrooms: number;
  extras: string[];
  style?: string;
  notes?: string;
}

export interface RoomSpec {
  key: string;
  type: RoomType;
  name: string;
  /** wanted area in m² (relative: rooms are scaled to fill the floor) */
  target: number;
  /** narrowest sensible width in m */
  minW: number;
  /** 0 public (street side), 1 service, 2 private (quiet side) */
  zone: 0 | 1 | 2;
  /** main bedroom with an ensuite (and a walk-in robe when deep enough) */
  suite?: boolean;
  /** small rooms keep only the depth they need; the rest goes to a neighbour */
  compact?: boolean;
  /** not asked for in the brief: added because the floor has space to spare */
  spare?: boolean;
}

export interface FloorProgram { rooms: RoomSpec[] }

const R = {
  living: { type: 'living', name: 'Living', target: 18, minW: 3.6, zone: 0 },
  livingKitchen: { type: 'living', name: 'Living & kitchen', target: 27, minW: 3.6, zone: 0 },
  livingKitchenDining: { type: 'living', name: 'Living, kitchen & dining', target: 33, minW: 3.6, zone: 0 },
  kitchen: { type: 'kitchen', name: 'Kitchen', target: 10, minW: 2.4, zone: 0 },
  dining: { type: 'dining', name: 'Dining', target: 11, minW: 2.7, zone: 0 },
  family: { type: 'living', name: 'Family room', target: 14, minW: 3.2, zone: 0 },
  entry: { type: 'entry', name: 'Entry', target: 5, minW: 1.5, zone: 0 },
  garage: { type: 'garage', name: 'Garage', target: 20, minW: 3.2, zone: 0 },
  study: { type: 'study', name: 'Study', target: 9, minW: 2.4, zone: 1 },
  laundry: { type: 'laundry', name: 'Laundry', target: 5, minW: 1.6, zone: 1, compact: true },
  powder: { type: 'wc', name: 'Powder room', target: 2.5, minW: 1.2, zone: 1, compact: true },
  guestBath: { type: 'bathroom', name: 'Guest bathroom', target: 5, minW: 1.7, zone: 1, compact: true },
  bathroom: { type: 'bathroom', name: 'Bathroom', target: 5.5, minW: 1.7, zone: 2, compact: true },
  master: { type: 'master', name: 'Main bedroom', target: 14, minW: 3.2, zone: 2 },
  bedroom: { type: 'bedroom', name: 'Bedroom', target: 10.5, minW: 2.7, zone: 2 },
  retreat: { type: 'other', name: 'Retreat', target: 10, minW: 2.7, zone: 2 },
  storage: { type: 'other', name: 'Storage', target: 4, minW: 1.4, zone: 1, compact: true },
} as const satisfies Record<string, Omit<RoomSpec, 'key'>>;

/** Ensuite and walk-in robe carved out of the main bedroom's share. */
export const SUITE = { ensuite: 5.5, robe: 3.5 };
const SUITE_EXTRA = SUITE.ensuite + SUITE.robe;

const mk = (k: keyof typeof R, over: Partial<RoomSpec> = {}): RoomSpec => ({ key: over.name ?? R[k].name, ...R[k], ...over } as RoomSpec);
const sum = (rs: RoomSpec[]) => rs.reduce((s, r) => s + r.target, 0);

/** Usable room area of a floor: its area inside the outside walls, less stairs and a hallway allowance. */
export function capacity(innerArea: number, stairs: boolean): number {
  return innerArea * 0.86 - (stairs ? 6.75 : 0) - 1.5;
}

/**
 * Rooms per floor for a brief. `inner` is each floor's area inside its outside walls (m²),
 * ground first; its length is the number of floors.
 */
export function buildProgram(brief: Brief, inner: number[]): FloorProgram[] {
  const n = Math.max(1, inner.length);
  const has = (e: string) => brief.extras.includes(e);
  const beds = Math.min(6, Math.max(1, Math.round(brief.bedrooms)));
  const baths = Math.min(4, Math.max(1, Math.round(brief.bathrooms)));
  const suite = baths >= 2;
  const gross = inner.reduce((a, b) => a + b, 0);
  const caps = inner.map((a) => capacity(a, n > 1));
  const multi = n > 1;

  // ---- public and service rooms (always on the ground floor) ----
  const pub: RoomSpec[] = [];
  const openPlan = has('open-plan');
  const separateDining = has('dining') || (multi && !openPlan);
  // (the garage is a fixed rectangle: a double one on large floors)
  if (has('garage')) pub.push(mk('garage', { target: inner[0] >= 260 ? 34.5 : inner[0] >= 170 ? 28 : 20 }));
  if (gross >= 110 || multi) pub.push(mk('entry'));
  if (openPlan) pub.push(mk(separateDining ? 'livingKitchen' : 'livingKitchenDining'));
  else pub.push(mk('living'), mk('kitchen'));
  if (separateDining) pub.push(mk('dining'));
  if (has('family')) pub.push(mk('family'));
  const service: RoomSpec[] = [];
  if (has('study')) service.push(mk('study'));
  if (has('laundry')) service.push(mk('laundry'));

  // ---- private rooms ----
  const master = mk('master', suite ? { suite: true, target: R.master.target + SUITE_EXTRA } : {});
  const bedrooms = Array.from({ length: beds - 1 }, () => mk('bedroom'));
  let shared = baths - (suite ? 1 : 0);

  if (!multi) {
    const priv: RoomSpec[] = [];
    for (let i = 0; i < shared; i++) priv.push(mk('bathroom'));
    if (has('powder')) service.push(mk('powder'));
    priv.push(...bedrooms, master);
    return [{ rooms: fill([...pub, ...service, ...priv], caps[0], 0, beds) }];
  }

  // ---- several floors: bedrooms go up, by available space ----
  const floors: RoomSpec[][] = inner.map(() => []);
  const left = caps.map((c) => c);
  const ground: RoomSpec[] = [...pub, ...service];
  left[0] -= sum(ground);
  const place = (r: RoomSpec, prefer: number[]) => {
    const order = [...prefer].sort((a, b) => left[b] - left[a]);
    const at = order.find((f) => left[f] >= r.target * 0.9) ?? -1;
    const f = at >= 0 ? at : left[0] >= r.target * 0.9 || prefer.length === 0 ? 0 : order[0];
    floors[f].push(r);
    left[f] -= r.target;
    return f;
  };
  const uppers = inner.map((_, i) => i).slice(1);
  if (has('master-ground')) { floors[0].push(master); left[0] -= master.target; }
  else place(master, uppers);
  for (const b of bedrooms) place(b, uppers);

  // a shared bathroom on every floor with ordinary bedrooms, then wherever most bedrooms are
  const bedsOn = (f: number) => floors[f].filter((r) => r.type === 'bedroom' || (r.type === 'master' && !r.suite)).length;
  for (const f of uppers) if (shared > 0 && bedsOn(f) > 0) { floors[f].push(mk('bathroom')); left[f] -= R.bathroom.target; shared--; }
  if (shared > 0 && bedsOn(0) > 0) { floors[0].push(mk('guestBath')); shared--; }
  while (shared > 0) {
    const most = uppers.reduce((a, b) => (bedsOn(b) > bedsOn(a) ? b : a), uppers[0]);
    if (bedsOn(most) > 0) floors[most].push(mk('bathroom'));
    else if (!floors[0].some((r) => r.type === 'bathroom')) floors[0].push(mk('guestBath'));
    else floors[most].push(mk('bathroom'));
    shared--;
  }
  if (!floors[0].some((r) => r.type === 'bathroom' || r.type === 'wc') || has('powder')) floors[0].push(mk('powder'));
  floors[0].unshift(...ground);

  return floors.map((rs, f) => {
    if (!rs.length) rs.push(mk('retreat', { name: f === 1 ? 'Retreat' : 'Sitting room' }));
    return { rooms: fill(rs, caps[f], f, beds) };
  });
}

/**
 * The comfortable size (m²) a room grows to when the floor is bigger than the brief needs. Past
 * it, spare space is better spent on another room than on a 37 m² kitchen or a 23 m² bedroom.
 */
export function comfortOf(r: Pick<RoomSpec, 'type' | 'name' | 'suite' | 'target'>): number {
  switch (r.type) {
    case 'living': return /dining/i.test(r.name) ? 52 : /kitchen/i.test(r.name) ? 44 : /family|rumpus/i.test(r.name) ? 22 : 30;
    case 'kitchen': return 15;
    case 'dining': return 15;
    case 'entry': return 6;
    case 'study': return 12;
    case 'laundry': return 6.5;
    case 'wc': return 3;
    case 'bathroom': return 7;
    case 'master': return 17.5 + (r.suite ? 6.5 + 4.5 : 0);
    case 'bedroom': return 13.5;
    case 'other': return /storage/i.test(r.name) ? 5 : 16;
    default: return r.target; // the garage is a fixed, car-sized rectangle
  }
}

/**
 * A floor bigger than its rooms need: first every room grows towards its comfortable size (all
 * by the same factor, so the hierarchy between rooms is kept), then spare space becomes rooms a
 * household actually uses, in order of usefulness (a laundry, a family room, a study, a powder
 * room, storage; upstairs a retreat, a study, linen storage), and only then do rooms stretch a
 * little past comfortable. Whatever is still left is spread by the layout, strip by strip.
 * A cramped floor keeps its rooms (they are scaled down later).
 */
function fill(rs: RoomSpec[], cap: number, level: number, beds = 0): RoomSpec[] {
  const out = [...rs];
  const grow = (limit: (r: RoomSpec) => number) => {
    for (let i = 0; i < 8; i++) {
      const s = sum(out);
      if (s >= cap - 0.5) return;
      const open = out.filter((r) => r.type !== 'garage' && r.target < limit(r) - 0.05);
      if (!open.length) return;
      const f = 1 + (cap - s) / sum(open);
      for (const r of open) r.target = Math.min(limit(r), r.target * f);
    }
  };
  grow(comfortOf);
  const has = (p: (r: RoomSpec) => boolean) => out.some(p);
  const spare = (over: Partial<RoomSpec>, k: keyof typeof R) => mk(k, { ...over, spare: true });
  // [room, the least spare area (m²) that justifies it]
  const extras: (() => [RoomSpec, number] | null)[] = level === 0
    ? [
      () => (has((r) => r.type === 'laundry') ? null : [spare({}, 'laundry'), 6]),
      () => (has((r) => r.name === 'Family room') ? null : [spare({}, 'family'), 15]),
      () => (has((r) => r.type === 'study') ? null : [spare({}, 'study'), 10]),
      () => (has((r) => r.type === 'dining') || has((r) => /dining/i.test(r.name)) ? null : [spare({}, 'dining'), 14]),
      () => [spare({}, 'storage'), 6],
      () => (has((r) => r.name === 'Rumpus room') ? null : [spare({ name: 'Rumpus room', target: 16 }, 'family'), 20]),
    ]
    : [
      () => (has((r) => r.name === 'Retreat') ? null : [spare({}, 'retreat'), 12]),
      () => (has((r) => r.type === 'study') ? null : [spare({ zone: 2 }, 'study'), 11]),
      () => [spare({ name: 'Linen store', target: 3 }, 'storage'), 5],
    ];
  // rooms stretch a little before another room is added: every extra room needs its own width
  // along the hallway, a door and a window, so a floor is only given what it can clearly hold
  grow((r) => comfortOf(r) * (r.compact ? 1.1 : 1.2));
  void beds;
  for (const make of extras) {
    const e = make();
    if (e && cap - sum(out) >= e[1] * 1.25) out.push(e[0]);
  }
  return out;
}

/** Final names: "Bedroom 2…", "Bathroom 1…" numbered across the whole house. */
export function nameRooms(programs: FloorProgram[]): void {
  let bed = 2, bath = 1;
  const baths = programs.flatMap((p) => p.rooms).filter((r) => r.type === 'bathroom' && r.name.startsWith('Bathroom')).length;
  for (const p of programs) {
    for (const r of p.rooms) {
      if (r.type === 'bedroom') r.name = `Bedroom ${bed++}`;
      else if (r.type === 'bathroom' && r.name.startsWith('Bathroom')) r.name = baths > 1 ? `Bathroom ${bath++}` : 'Bathroom';
    }
    const seen = new Map<string, number>();
    for (const r of p.rooms) {
      const c = (seen.get(r.name) ?? 0) + 1;
      seen.set(r.name, c);
      r.key = c > 1 ? `${r.name} ${c}` : r.name;
      if (c > 1) r.name = `${r.name} ${c}`;
    }
  }
}
