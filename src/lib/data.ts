// Single place where the JSON data is pulled into the client bundle.
import ATTRIBUTES from '../data/attributes.json';
import ABILITIES from '../data/abilities.json';
import VIRTUES from '../data/virtues.json';
import BACKGROUNDS from '../data/backgrounds.json';
import RULES from '../data/rules.json';

import mortal from '../data/splats/mortal.json';
import solar from '../data/splats/solar.json';
import abyssal from '../data/splats/abyssal.json';
import lunar from '../data/splats/lunar.json';
import sidereal from '../data/splats/sidereal.json';
import dragonBlooded from '../data/splats/dragon-blooded.json';
import infernal from '../data/splats/infernal.json';

export const SPLATS: any[] = [mortal, solar, abyssal, lunar, sidereal, dragonBlooded, infernal]
  .sort((a: any, b: any) => a.order - b.order);

export const SPLAT_BY_ID: Record<string, any> =
  Object.fromEntries(SPLATS.map((s: any) => [s.id, s]));

/** Trait lists, in the shape calc.js expects. */
export const DATA = {
  attributes: ATTRIBUTES as any[],
  abilities: ABILITIES as any[],
  virtues: VIRTUES as any[],
};

export const ATTRIBUTE_GROUPS = [
  { id: 'physical', name: 'Physical' },
  { id: 'social', name: 'Social' },
  { id: 'mental', name: 'Mental' },
];

export { RULES, BACKGROUNDS };
