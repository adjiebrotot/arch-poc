"""
Author a small, *properly textured* IFC4 house for testing the viewer.

    python3 scripts/make-textured-ifc.py <folder-with-ambientCG-*_Color.jpg>

Textures: ambientCG (CC0). Covers every way IFC4 can carry textures:
  * IfcSurfaceStyleWithTextures + IfcImageTexture (external file, default mapping + TextureTransform scale)
  * IfcIndexedTriangleTextureMap on IfcTriangulatedFaceSet (explicit UVs)
  * IfcBlobTexture (JPEG embedded in the IFC)
  * IfcPixelTexture (raw pixels inline)
"""
import sys, os, io, glob
import ifcopenshell, ifcopenshell.guid
from PIL import Image

SRC = sys.argv[1]
OUT = 'public/samples/textured-cottage'
os.makedirs(f'{OUT}/textures', exist_ok=True)

def tex_file(pattern, name, size=512, quality=82):
    p = glob.glob(os.path.join(SRC, '**', f'{pattern}*_Color.jpg'), recursive=True)[0]
    im = Image.open(p).convert('RGB').resize((size, size), Image.LANCZOS)
    im.save(f'{OUT}/textures/{name}.jpg', quality=quality, optimize=True)
    return f'textures/{name}.jpg'

def tex_bytes(pattern, size=256, quality=78):
    p = glob.glob(os.path.join(SRC, '**', f'{pattern}*_Color.jpg'), recursive=True)[0]
    b = io.BytesIO(); Image.open(p).convert('RGB').resize((size, size), Image.LANCZOS).save(b, 'JPEG', quality=quality)
    return b.getvalue()

f = ifcopenshell.file(schema='IFC4')
G = lambda: ifcopenshell.guid.new()
P3 = lambda *c: f.createIfcCartesianPoint([float(x) for x in c])
D3 = lambda *c: f.createIfcDirection([float(x) for x in c])
def A3(o=(0, 0, 0), z=(0, 0, 1), x=(1, 0, 0)): return f.createIfcAxis2Placement3D(P3(*o), D3(*z), D3(*x))
def place(o=(0, 0, 0), rel=None, z=(0, 0, 1), x=(1, 0, 0)): return f.createIfcLocalPlacement(rel, A3(o, z, x))

owner = f.createIfcOwnerHistory(f.createIfcPersonAndOrganization(f.createIfcPerson(None, None, 'Architect Tool POC'), f.createIfcOrganization(None, 'Architect Tool POC')),
                                f.createIfcApplication(f.createIfcOrganization(None, 'Architect Tool POC'), '1.0', 'Textured test model', 'linea-tex'), None, 'ADDED', None, None, None, 0)
units = f.createIfcUnitAssignment([f.createIfcSIUnit(None, 'LENGTHUNIT', None, 'METRE'), f.createIfcSIUnit(None, 'AREAUNIT', None, 'SQUARE_METRE'),
                                   f.createIfcSIUnit(None, 'PLANEANGLEUNIT', None, 'RADIAN')])
ctx = f.createIfcGeometricRepresentationContext(None, 'Model', 3, 1e-5, A3(), None)
body_ctx = f.createIfcGeometricRepresentationSubContext('Body', 'Model', None, None, None, None, ctx, None, 'MODEL_VIEW', None)
project = f.createIfcProject(G(), owner, 'Textured Cottage', 'Textured IFC4 test model', None, None, None, [ctx], units)
site = f.createIfcSite(G(), owner, 'Site', None, None, place(), None, None, 'ELEMENT', None, None, None, None, None)
bldg = f.createIfcBuilding(G(), owner, 'Cottage', None, None, place(rel=site.ObjectPlacement), None, None, 'ELEMENT', None, None, None)
storey = f.createIfcBuildingStorey(G(), owner, 'Ground floor', None, None, place(rel=bldg.ObjectPlacement), None, None, 'ELEMENT', 0.0)
f.createIfcRelAggregates(G(), owner, None, None, project, [site])
f.createIfcRelAggregates(G(), owner, None, None, site, [bldg])
f.createIfcRelAggregates(G(), owner, None, None, bldg, [storey])
in_storey, in_site = [], []

# ---- textures & styles ---------------------------------------------------------
def scale_op(metres):  # texture repeats every `metres` (default mapping, 1 unit = 1 m)
    return f.createIfcCartesianTransformationOperator2D(None, None, f.createIfcCartesianPoint([0., 0.]), 1.0 / metres)
def image_tex(url, metres=None):
    return f.createIfcImageTexture(True, True, 'MODULATE', scale_op(metres) if metres else None, None, url)
def surface_style(name, rgb, tex=None, transparency=0.0, specular=0.2):
    rend = f.createIfcSurfaceStyleRendering(f.createIfcColourRgb(None, *rgb), transparency, None, None, None, None,
                                           f.createIfcNormalisedRatioMeasure(specular), f.createIfcSpecularExponent(32.0), 'NOTDEFINED')
    styles = [rend] + ([f.createIfcSurfaceStyleWithTextures([tex])] if tex else [])
    return f.createIfcSurfaceStyle(name, 'BOTH', styles)
def style(item, s): f.createIfcStyledItem(item, [s], None)

brick_tex = image_tex(tex_file('Bricks059', 'bricks'), metres=1.2)
floor_tex = image_tex(tex_file('WoodFloor051', 'wood-floor'), metres=1.5)
plaster_tex = image_tex(tex_file('Plaster001', 'plaster'), metres=2.0)
roof_tex = image_tex(tex_file('RoofingTiles006', 'roof-tiles'))
grass_tex = image_tex(tex_file('Grass004', 'grass'))
blob = tex_bytes('PavingStones070')
paving_tex = f.createIfcBlobTexture(True, True, 'MODULATE', None, None, 'JPG', ''.join(f'{b:08b}' for b in blob))
# 4×4 RGB pixel texture: timber-like stripes for door leaves
px = []
for y in range(4):
    for x in range(4):
        r, g, b = (0x7A, 0x4E, 0x2C) if (x + y) % 2 else (0x96, 0x63, 0x3A)
        px.append(f'{r:08b}{g:08b}{b:08b}')
door_tex = f.createIfcPixelTexture(True, True, 'MODULATE', scale_op(0.25), None, 4, 4, 3, px)

S_BRICK = surface_style('Brick', (0.62, 0.32, 0.24), brick_tex)
S_FLOOR = surface_style('Oak floor', (0.72, 0.55, 0.38), floor_tex, specular=0.4)
S_PLASTER = surface_style('Plaster', (0.94, 0.93, 0.9), plaster_tex)
S_ROOF = surface_style('Roof tiles', (0.45, 0.2, 0.16), roof_tex)
S_GRASS = surface_style('Lawn', (0.35, 0.5, 0.25), grass_tex)
S_PAVING = surface_style('Paving', (0.6, 0.58, 0.55), paving_tex)
S_DOOR = surface_style('Timber door', (0.55, 0.36, 0.2), door_tex)
S_GLASS = surface_style('Glass', (0.7, 0.82, 0.88), None, transparency=0.75, specular=0.9)
S_FRAME = surface_style('Aluminium', (0.25, 0.26, 0.27), None, specular=0.6)

# ---- geometry helpers --------------------------------------------------------------
def rect_profile(x0, y0, x1, y1):
    return f.createIfcRectangleProfileDef('AREA', None, f.createIfcAxis2Placement2D(f.createIfcCartesianPoint([(x0 + x1) / 2, (y0 + y1) / 2]), None), x1 - x0, y1 - y0)
def extrusion(x0, y0, x1, y1, z0, h):
    return f.createIfcExtrudedAreaSolid(rect_profile(x0, y0, x1, y1), A3((0, 0, z0)), D3(0, 0, 1), h)
def shape(items, kind='SweptSolid'):
    return f.createIfcProductDefinitionShape(None, None, [f.createIfcShapeRepresentation(body_ctx, 'Body', kind, items)])
def faceset(points, tris, uvs=None, tex=None, closed=False):
    """points: list of xyz; tris: list of 1-based index triples (CCW from outside); uvs: per-point uv."""
    fs = f.createIfcTriangulatedFaceSet(f.createIfcCartesianPointList3D([[float(c) for c in p] for p in points]), None, closed, tris, None)
    if uvs is not None:
        f.createIfcIndexedTriangleTextureMap([tex], fs, f.createIfcTextureVertexList([[float(u), float(v)] for u, v in uvs]), None)
    return fs
def pset(el, name, props):
    ps = f.createIfcPropertySet(G(), owner, name, None, [f.createIfcPropertySingleValue(k, None, v, None) for k, v in props.items()])
    f.createIfcRelDefinesByProperties(G(), owner, None, None, [el], ps)
def add(cls, name, rep, container=in_storey, **kw):
    el = f.create_entity(cls, GlobalId=G(), OwnerHistory=owner, Name=name, ObjectPlacement=place(rel=storey.ObjectPlacement), Representation=rep, **kw)
    container.append(el)
    return el

W, D, T, H = 10.0, 7.0, 0.25, 2.8   # footprint, wall thickness, wall height
x0, x1, y0, y1 = -W / 2, W / 2, -D / 2, D / 2

# ---- walls with openings ---------------------------------------------------------------
walls = {}
for name, (a, b, c, d) in {
    'South wall': (x0, y0, x1, y0 + T), 'North wall': (x0, y1 - T, x1, y1),
    'West wall': (x0, y0 + T, x0 + T, y1 - T), 'East wall': (x1 - T, y0 + T, x1, y1 - T),
}.items():
    solid = extrusion(a, b, c, d, 0, H)
    style(solid, S_BRICK)
    w = add('IfcWall', name, shape([solid]), PredefinedType='SOLIDWALL')
    pset(w, 'Pset_WallCommon', {'IsExternal': f.createIfcBoolean(True), 'LoadBearing': f.createIfcBoolean(True)})
    walls[name] = w
iw_solid = extrusion(1.0, y0 + T, 1.12, y1 - T, 0, H)
style(iw_solid, S_PLASTER)
walls['Partition'] = add('IfcWall', 'Partition', shape([iw_solid]), PredefinedType='PARTITIONING')

def opening_in(wall, bx0, by0, bx1, by1, z0, h, fill_cls=None, fill_name='', glazed=True):
    op = f.createIfcOpeningElement(G(), owner, 'Opening', None, None, place(rel=storey.ObjectPlacement), shape([extrusion(bx0, by0, bx1, by1, z0, h)]), None, 'OPENING')
    f.createIfcRelVoidsElement(G(), owner, None, None, wall, op)
    if not fill_cls: return
    horiz = (bx1 - bx0) > (by1 - by0)
    mid = ((bx0 + bx1) / 2, (by0 + by1) / 2)
    items = []
    if glazed:
        g = extrusion(bx0 + 0.05, mid[1] - 0.01, bx1 - 0.05, mid[1] + 0.01, z0 + 0.05, h - 0.1) if horiz else extrusion(mid[0] - 0.01, by0 + 0.05, mid[0] + 0.01, by1 - 0.05, z0 + 0.05, h - 0.1)
        style(g, S_GLASS); items.append(g)
        for fr in ([extrusion(bx0, mid[1] - .04, bx1, mid[1] + .04, z0, .05), extrusion(bx0, mid[1] - .04, bx1, mid[1] + .04, z0 + h - .05, .05),
                    extrusion(bx0, mid[1] - .04, bx0 + .05, mid[1] + .04, z0, h), extrusion(bx1 - .05, mid[1] - .04, bx1, mid[1] + .04, z0, h)] if horiz else
                   [extrusion(mid[0] - .04, by0, mid[0] + .04, by1, z0, .05), extrusion(mid[0] - .04, by0, mid[0] + .04, by1, z0 + h - .05, .05),
                    extrusion(mid[0] - .04, by0, mid[0] + .04, by0 + .05, z0, h), extrusion(mid[0] - .04, by1 - .05, mid[0] + .04, by1, z0, h)]):
            style(fr, S_FRAME); items.append(fr)
    else:
        leaf = extrusion(bx0 + .02, mid[1] - .025, bx1 - .02, mid[1] + .025, z0, h - .02) if horiz else extrusion(mid[0] - .025, by0 + .02, mid[0] + .025, by1 - .02, z0, h - .02)
        style(leaf, S_DOOR); items.append(leaf)
    kw = dict(OverallHeight=h, OverallWidth=max(bx1 - bx0, by1 - by0))
    el = add(fill_cls, fill_name, shape(items), **kw)
    f.createIfcRelFillsElement(G(), owner, None, None, op, el)

S, N, Wst, E = walls['South wall'], walls['North wall'], walls['West wall'], walls['East wall']
opening_in(S, -3.0, y0 - .1, -2.0, y0 + T + .1, 0, 2.1, 'IfcDoor', 'Front door', glazed=False)
opening_in(S, 1.6, y0 - .1, 3.6, y0 + T + .1, 0.9, 1.3, 'IfcWindow', 'Kitchen window')
opening_in(S, -1.4, y0 - .1, 0.2, y0 + T + .1, 0.9, 1.3, 'IfcWindow', 'Living window')
opening_in(N, -3.8, y1 - T - .1, -0.6, y1 + .1, 0.05, 2.2, 'IfcWindow', 'Garden slider')
opening_in(N, 2.2, y1 - T - .1, 3.8, y1 + .1, 0.9, 1.3, 'IfcWindow', 'Bedroom window')
opening_in(Wst, x0 - .1, -1.0, x0 + T + .1, 1.0, 0.9, 1.3, 'IfcWindow', 'West window')
opening_in(E, x1 - T - .1, -0.8, x1 + .1, 0.8, 0.9, 1.3, 'IfcWindow', 'East window')
opening_in(walls['Partition'], 0.95, -0.5, 1.17, 0.4, 0, 2.05, 'IfcDoor', 'Bedroom door', glazed=False)

# ---- gable walls (triangulated, explicit UVs on brick) -------------------------------------
RIDGE = H + 2.0
for name, xa, xb in [('West gable', x0, x0 + T), ('East gable', x1 - T, x1)]:
    pts = [(xa, y0, H), (xa, y1, H), (xa, 0, RIDGE), (xb, y0, H), (xb, y1, H), (xb, 0, RIDGE)]
    tris = [(1, 3, 2), (4, 5, 6), (1, 2, 5), (1, 5, 4), (2, 3, 6), (2, 6, 5), (3, 1, 4), (3, 4, 6)]
    uvs = [(p[1] / 1.2, p[2] / 1.2) for p in pts]
    fs = faceset(pts, tris, uvs, brick_tex, closed=True)
    style(fs, S_BRICK)
    add('IfcWall', name, shape([fs], 'Tessellation'), PredefinedType='SOLIDWALL')

# ---- roof (two pitched planes, explicit UVs) ----------------------------------------------
O = 0.45  # overhang
roof_items = []
for side in (-1, 1):
    ye = side * (D / 2 + O)          # eave line
    ze = H - O * (2.0 / (D / 2))     # keep the pitch through the overhang
    th = 0.15
    top = [(x0 - O, ye, ze), (x1 + O, ye, ze), (x1 + O, 0, RIDGE), (x0 - O, 0, RIDGE)]
    bot = [(x, y, z - th) for x, y, z in top]
    pts = top + bot
    slope_len = ((ye) ** 2 + (RIDGE - ze) ** 2) ** 0.5
    uvs = [((p[0] - x0) / 1.5, (abs(p[1] - ye) / abs(ye)) * slope_len / 1.5) for p in pts]
    q = [(1, 2, 3), (1, 3, 4), (5, 7, 6), (5, 8, 7), (1, 5, 6), (1, 6, 2), (2, 6, 7), (2, 7, 3), (3, 7, 8), (3, 8, 4), (4, 8, 5), (4, 5, 1)]
    if side < 0:  # mirror winding for the other slope
        q = [(a, c, b) for a, b, c in q]
    fs = faceset(pts, q, uvs, roof_tex, closed=True)
    style(fs, S_ROOF)
    roof_items.append(fs)
add('IfcRoof', 'Gable roof', shape(roof_items, 'Tessellation'), PredefinedType='GABLE_ROOF')

# ---- floor, ceiling --------------------------------------------------------------------------
fl = extrusion(x0 + T, y0 + T, x1 - T, y1 - T, -0.2, 0.2); style(fl, S_FLOOR)
add('IfcSlab', 'Ground floor slab', shape([fl]), PredefinedType='FLOOR')
cl = extrusion(x0 + T, y0 + T, x1 - T, y1 - T, H - 0.02, 0.02); style(cl, S_PLASTER)
add('IfcCovering', 'Ceiling', shape([cl]), PredefinedType='CEILING')

# ---- deck (timber, default mapping) and path (embedded blob texture, explicit UVs) -----------
dk = extrusion(x0, y1, x1, y1 + 2.6, -0.15, 0.15); style(dk, S_FLOOR)
add('IfcSlab', 'Timber deck', shape([dk]), PredefinedType='LANDING')
pts = [(-3.2, y0, -0.01), (-1.8, y0, -0.01), (-1.8, y0 - 6, -0.01), (-3.2, y0 - 6, -0.01),
       (-3.2, y0, -0.06), (-1.8, y0, -0.06), (-1.8, y0 - 6, -0.06), (-3.2, y0 - 6, -0.06)]
uvs = [((p[0] + 3.2) / 1.4, (y0 - p[1]) / 1.4) for p in pts]
fs = faceset(pts, [(1, 4, 3), (1, 3, 2), (5, 6, 7), (5, 7, 8), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 4, 8), (3, 8, 7), (4, 1, 5), (4, 5, 8)], uvs, paving_tex, closed=True)
style(fs, S_PAVING)
add('IfcSlab', 'Garden path', shape([fs], 'Tessellation'), container=in_site, PredefinedType='BASESLAB')

# ---- lawn (site) ---------------------------------------------------------------------------------
L = 22.0
pts = [(-L, -L, -0.04), (L, -L, -0.04), (L, L, -0.04), (-L, L, -0.04)]
fs = faceset(pts, [(1, 2, 3), (1, 3, 4)], [((p[0] + L) / 2.5, (p[1] + L) / 2.5) for p in pts], grass_tex)
style(fs, S_GRASS)
add('IfcGeographicElement', 'Lawn', shape([fs], 'Tessellation'), container=in_site, PredefinedType='TERRAIN')

f.createIfcRelContainedInSpatialStructure(G(), owner, None, None, in_storey, storey)
f.createIfcRelContainedInSpatialStructure(G(), owner, None, None, in_site, site)
f.write(f'{OUT}/textured-cottage.ifc')
print('wrote', f'{OUT}/textured-cottage.ifc', os.path.getsize(f'{OUT}/textured-cottage.ifc') // 1024, 'KB')
