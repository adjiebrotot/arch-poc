// Public surface of the vendored openPlan3D geometry core (see MODIFICATIONS.md).
export type { Floor as OP3DFloor, Wall as OP3DWall, Room as OP3DRoom, Door as OP3DDoor, Window as OP3DWindow, Point as OP3DPoint } from './src/models/types';
export { detectRooms, resolveRoomGeometry, getRoomPolygon, roomCentroid } from './src/utils/roomDetection';
