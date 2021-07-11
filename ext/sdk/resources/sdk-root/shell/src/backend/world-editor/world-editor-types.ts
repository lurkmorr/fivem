//                            posX    posY    posZ    rotX    rotY    rotZ
export type WECam = [number, number, number, number, number, number];

export type WEEntityMatrix = [
  number, number, number, number, // right
  number, number, number, number, // forward
  number, number, number, number, // up
  number, number, number, number, // at
];

export interface WEMapPatch {
  label: string,
  mat: WEEntityMatrix,
  cam: WECam,
}

export type WEMapAdditionGroup = -1 | string;

export interface WEMapAddition {
  label: string,
  hash: number,
  grp: WEMapAdditionGroup,
  mat: WEEntityMatrix,
  cam: WECam,
}

export interface WEApplyPatchRequest {
  patch: WEMapPatch,
  mapDataHash: number,
  entityHash: number,
}

export interface WESetAdditionRequest {
  id: string,
  object: WEMapAddition,
}

export type WEApplyAdditionChangeRequest = { id: string } & Partial<WEMapAddition>;

export interface WESetAdditionGroupRequest {
  additionId: string,
  grp: WEMapAdditionGroup,
}

export interface WECreateAdditionGroupRequest {
  grp: string,
  label: string,
}

export interface WEDeleteAdditionGroupRequest {
  grp: string,
  deleteAdditions: boolean,
}

export interface WESetAdditionGroupNameRequest {
  grp: string,
  label: string,
}

export interface WEDeleteAdditionRequest {
  id: string,
}

export enum WEMapVersion {
  V1 = 1,
  V2 = 2,
}

export interface WEMap {
  version: WEMapVersion,
  meta: {
    cam: WECam,
  },
  patches: {
    [mapDataHash: number]: {
      [entityHash: number]: WEMapPatch,
    },
  },
  additionGroups: Record<string, {
    label: string,
  }>,
  additions: {
    [entityId: string]: WEMapAddition,
  },
}
