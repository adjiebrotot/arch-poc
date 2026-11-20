import { generatePlan, type GeneratorInput } from './generator';

/** Seeded starter templates (same seed ⇒ same plan on every device). */
export const TEMPLATES: (GeneratorInput & { id: string; blurb: string })[] = [
  { id: 'cottage', title: 'The Cottage', blurb: 'Compact single-level, open-plan living', area: 80, floors: 1, bedrooms: 2, bathrooms: 1, extras: ['open-plan', 'laundry'], seed: 7 },
  { id: 'family', title: 'The Family Home', blurb: 'Single level with garage and study', area: 165, floors: 1, bedrooms: 3, bathrooms: 2, extras: ['garage', 'study', 'laundry'], seed: 21 },
  { id: 'townhouse', title: 'The Townhouse', blurb: 'Two storeys, four bedrooms', area: 190, floors: 2, bedrooms: 4, bathrooms: 3, extras: ['garage', 'laundry'], seed: 5 },
];

export const templatePlan = (id: string) => {
  const t = TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[0];
  return generatePlan(t);
};
