import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// GitHub Pages: https://f-neves.github.io/exalted-sheet/
const BASE = '/exalted-sheet';

export default defineConfig({
  site: 'https://f-neves.github.io',
  base: BASE + '/',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  integrations: [sitemap()],
});
