// @ts-check
import { defineConfig, fontProviders } from 'astro/config';
import { satteri } from '@astrojs/markdown-satteri';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

const site = 'https://allanmxr.com.br';
const newTabNotice = { pt: '(abre em nova aba)', en: '(opens in a new tab)' };

export default defineConfig({
  site,
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [
    sitemap({
      filter: (page) => !/\/404$/.test(page) && !/^\/en(\/|$)/.test(new URL(page).pathname),
    }),
  ],
  fonts: [
    {
      provider: fontProviders.local(),
      name: 'Funnel Display',
      cssVariable: '--font-funnel-display',
      fallbacks: ['system-ui', 'sans-serif'],
      options: {
        variants: [{ src: ['@fontsource-variable/funnel-display/files/funnel-display-latin-wght-normal.woff2'], weight: '300 800', style: 'normal' }],
      },
    },
    {
      provider: fontProviders.local(),
      name: 'Funnel Sans',
      cssVariable: '--font-funnel-sans',
      fallbacks: ['system-ui', 'sans-serif'],
      options: {
        variants: [{ src: ['@fontsource-variable/funnel-sans/files/funnel-sans-latin-wght-normal.woff2'], weight: '300 800', style: 'normal' }],
      },
    },
    {
      provider: fontProviders.local(),
      name: 'Silkscreen',
      cssVariable: '--font-silkscreen',
      fallbacks: ['ui-monospace', 'monospace'],
      options: {
        variants: [{ src: ['@fontsource/silkscreen/files/silkscreen-latin-400-normal.woff2'], weight: 400, style: 'normal' }],
      },
    },
  ],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light-default', dark: 'github-dark-default' },
      defaultColor: false,
    },
    processor: satteri({
      hastPlugins: [
        {
          name: 'external-links',
          element: {
            filter: ['a'],
            visit(node, context) {
              const href = node.properties?.href;
              if (typeof href !== 'string' || !/^https?:\/\//.test(href) || new URL(href).origin === site) return;
              context.setProperty(node, 'target', '_blank');
              context.setProperty(node, 'rel', ['noopener', 'noreferrer']);
              const locale = /\/(cases|stories)-en\//.test(context.fileURL?.pathname ?? '') ? 'en' : 'pt';
              context.appendChild(node, {
                type: 'element',
                tagName: 'span',
                properties: { className: ['sr-only'] },
                children: [{ type: 'text', value: ` ${newTabNotice[locale]}` }],
              });
            },
          },
        },
      ],
    }),
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
