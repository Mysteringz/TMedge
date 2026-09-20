/**
 * The campus as a student thinks of it: venues you can walk to, each holding
 * one or more sensed spaces (our floors).
 *
 * The edge knows floors, not buildings, and it has no business knowing which
 * photograph or 3D model a web page shows. That presentation belongs here,
 * keyed by floor id. A floor with no entry still works: it gets the 2D plan
 * and generic directions, just not a 3D model.
 *
 * Adding Chi Wah or the Main Library later = flip `open` to true once its
 * edge publishes floors, and add a SpaceInfo per floor.
 */

export interface Venue {
  id: string;
  name: string;
  /** Short form for phone screens and breadcrumbs. */
  shortName: string;
  /** Small uppercase line above the name. */
  kicker: string;
  /** Photograph, shown in full colour. */
  photo: string;
  caption: string;
  shortCaption?: string;
  /** Floors published by an edge that belong to this venue. */
  floorIds: string[];
  /** False = tile shown disabled ("Sensors coming soon"). */
  open: boolean;
  /** How a student gets in, used as step 1 of the directions. */
  entrance: string;
}

export interface SpaceInfo {
  /** "G Floor", "LG Floor". */
  floorLabel: string;
  /** 3D model, or null for no 3D card. */
  model: { src: string; room: string; columns: number; rows: number } | null;
  /** Step 2 of the directions: from the entrance to this room. */
  approach: string;
  walkMinutes: number;
  /** What is at the top of the 2D plan. */
  entranceNote: string;
}

export const VENUES: Venue[] = [
  {
    id: 'twf',
    name: 'Tam Wing Fan Innovation Wing',
    shortName: 'Innovation Wing',
    kicker: 'Haking Wong · G & LG',
    photo: '/assets/images/twf-innovation-wing.jpg',
    caption: 'Tam Wing Fan Innovation Wing — G & LG floors, Haking Wong Building',
    /** Shorter caption for phones. */
    shortCaption: 'Haking Wong Building · G & LG',
    floorIds: ['iw-maker-a', 'iw-event-lg'],
    open: true,
    entrance: 'Enter the Innovation Wing from the Haking Wong Building podium, G floor.',
  },
  {
    id: 'cw',
    name: 'Chi Wah Learning Commons',
    shortName: 'Chi Wah',
    kicker: 'Centennial Campus',
    photo: '/assets/images/chi-wah.jpg',
    caption: 'Chi Wah Learning Commons — Centennial Campus',
    floorIds: [],
    open: false,
    entrance: '',
  },
  {
    id: 'ml',
    name: 'HKU Main Library',
    shortName: 'Main Library',
    kicker: 'Main Campus',
    photo: '/assets/images/Library.jpg',
    caption: 'HKU Main Library — Main Campus',
    floorIds: [],
    open: false,
    entrance: '',
  },
];

export const SPACES: Record<string, SpaceInfo> = {
  'iw-maker-a': {
    floorLabel: 'G Floor',
    model: { src: '/assets/floors/makerspace-floor.glb', room: 'Makerspace A floor', columns: 5, rows: 2 },
    approach: 'Stay on G floor and walk past the reception desk into Makerspace A on your right.',
    walkMinutes: 2,
    entranceNote: 'Entrance / lift lobby at the top of the plan.',
  },
  'iw-event-lg': {
    floorLabel: 'LG Floor',
    model: { src: '/assets/floors/event-floor.glb', room: 'Event floor', columns: 5, rows: 2 },
    approach: 'Take the main stair (or lift) down one level to LG — the Open Event Area is straight ahead.',
    walkMinutes: 3,
    entranceNote: 'Stair and lift at the top of the plan.',
  },
};

export function venueOfFloor(floorId: string): Venue | null {
  return VENUES.find((v) => v.floorIds.includes(floorId)) ?? null;
}

export function spaceInfo(floorId: string): SpaceInfo {
  return SPACES[floorId] ?? {
    floorLabel: '',
    model: null,
    approach: 'Follow the signs to the study area.',
    walkMinutes: 2,
    entranceNote: 'Entrance at the top of the plan.',
  };
}
