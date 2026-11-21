import { execFile } from 'node:child_process';
import { copyFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { preview } from 'astro';
import { locales, ui } from '../src/i18n/ui.ts';

const run = promisify(execFile);
const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const server = await preview({ logLevel: 'warn', server: { port: 4322 } });

try {
  for (const locale of locales) {
    const file = ui[locale].resumePdf;
    const page = new URL(locale === 'pt' ? '/resume' : `/${locale}/resume`, `http://localhost:${server.port}`);
    await run(chrome, [
      '--headless=new',
      '--no-pdf-header-footer',
      '--blink-settings=preferredColorScheme=1',
      '--virtual-time-budget=5000',
      `--print-to-pdf=dist${file}`,
      page.href,
    ]);
    await copyFile(`dist${file}`, `public${file}`);
    console.log(`${file} generated from ${page.pathname}`);
  }
} finally {
  await server.stop();
}
