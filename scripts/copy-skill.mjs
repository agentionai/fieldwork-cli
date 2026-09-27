import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { URL } from 'node:url';

// The skill is canonical in the web app, which serves it; the public CLI repository carries
// a copy in skill/. Whichever this checkout has.
const mirrored = new URL('../skill/SKILL.md', import.meta.url);
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
copyFileSync(
  existsSync(mirrored)
    ? mirrored
    : new URL('../../web/public/skills/fieldwork/SKILL.md', import.meta.url),
  new URL('../dist/fieldwork-skill.md', import.meta.url),
);
