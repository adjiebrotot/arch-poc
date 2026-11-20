/** Human label for an IFC class, for non-technical clients. */
export function friendlyType(t: string): string {
  const m: Record<string, string> = {
    IfcWallStandardCase: 'Wall', IfcWall: 'Wall', IfcSlab: 'Floor / slab', IfcWindow: 'Window', IfcDoor: 'Door', IfcRoof: 'Roof',
    IfcStair: 'Stairs', IfcStairFlight: 'Stairs', IfcRailing: 'Railing', IfcBeam: 'Beam', IfcColumn: 'Column', IfcFooting: 'Foundation',
    IfcFurnishingElement: 'Furniture', IfcCovering: 'Ceiling / finish', IfcMember: 'Frame member', IfcPlate: 'Panel', IfcCurtainWall: 'Glass wall',
  };
  return m[t] ?? t.replace(/^Ifc/, '');
}
