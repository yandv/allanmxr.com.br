import { readFile } from 'node:fs/promises';

const host = 'allanmxr.com.br';
const key = 'a35fb46d13366778bbb48a26150551a0';

const sitemap = await readFile(new URL('../dist/sitemap-0.xml', import.meta.url), 'utf8');
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList }),
});

console.log(`IndexNow: ${response.status} for ${urlList.length} URLs`);
