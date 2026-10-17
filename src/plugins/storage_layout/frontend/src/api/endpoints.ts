/**
 * URL builders for the Storage Layout plugin REST API.
 *
 * The design mounts the API at `/plugin/storage-layout/api/v1/` through the
 * plugin `UrlsMixin` (see design section 5). Trailing slashes are required.
 */

export const PLUGIN_SLUG = 'storage-layout';
export const API_BASE = `/plugin/${PLUGIN_SLUG}/api/v1/`;

const join = (...parts: (string | number)[]): string =>
  `${API_BASE}${parts
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/')}/`;

export const Endpoints = {
  cabinets: () => join('cabinets'),
  cabinet: (id: string) => join('cabinets', id),
  cabinetLayout: (id: string) => join('cabinets', id, 'layout'),
  cabinetValidateLayout: (id: string) =>
    join('cabinets', id, 'validate-layout'),
  cabinetElectrical: (id: string) => join('cabinets', id, 'electrical'),
  cabinetMappingPreview: (id: string) =>
    join('cabinets', id, 'mapping-preview'),
  cabinetMappingPublish: (id: string) =>
    join('cabinets', id, 'mapping-publish'),
  cabinetArm: (id: string) => join('cabinets', id, 'arm'),
  cabinetDisarm: (id: string) => join('cabinets', id, 'disarm'),
  cabinetStop: (id: string) => join('cabinets', id, 'stop'),
  cabinetPixelTests: (id: string) => join('cabinets', id, 'pixel-tests'),
  drawerLayout: (id: string) => join('drawers', id, 'layout'),
  locationBinding: (id: string | number) => join('locations', id, 'binding'),
  controllerObserve: (id: string) => join('controllers', id, 'observe'),
  controllerImportPreview: (id: string) =>
    join('controllers', id, 'import-preview'),
  controllerImport: (id: string) => join('controllers', id, 'import'),
  controllerApprove: (id: string) =>
    join('controllers', id, 'approve-configuration'),
  translate: () => join('translate'),
  discovery: () => join('discovery'),
  locateSessions: () => join('locate-sessions'),
  locateSession: (id: string) => join('locate-sessions', id),
  locateSessionStop: (id: string) => join('locate-sessions', id, 'stop'),
  profiles: () => join('profiles'),
  profile: (id: string) => join('profiles', id),
  jobs: (id: string) => join('jobs', id)
} as const;
