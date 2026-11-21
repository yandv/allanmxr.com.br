# allanmxr.com.br

Site pessoal e currículo do Allan Marcelino. Astro estático com Tailwind, servido por um Worker da Cloudflare que escolhe o idioma (pt ou en) na mesma URL.

## Onde editar cada coisa

| O quê | Onde |
| --- | --- |
| Experiência no currículo | Bloco `resume` no frontmatter do case do emprego, em `src/content/cases/<id>.md` (pt) e `src/content/cases-en/<id>.md` (en). Campos: `company`, `title`, `location`, `start` e `end` em `YYYY-MM` (sem `end` = atual), `sideProject`, `bullets`, `order`. Duas posições na mesma empresa viram uma lista (veja `dbserver.md`). Esse bloco não aparece no site. |
| Projetos no currículo | Bloco `resume` com `summary` e `order` no case do projeto (veja `achalote.md`). |
| Formação | `src/content/education/*.yaml`, um arquivo por curso, com textos em `pt` e `en` no mesmo arquivo. Alimenta o currículo e a seção de formação do site. |
| Cargo, resumo profissional, habilidades, idiomas, contatos | `src/data/profile.ts` (`profile`, `skills`, `languages`). |
| Emprego atual, projetos paralelos, trajetória e scrapers da home | `src/data/profile.ts` (`job`, `sideProjects`, `journey`, `scrapers`). |
| Textos de interface (botões, títulos, rótulos) | `src/i18n/ui.ts`. |
| Cases | `src/content/cases/*.md` e `src/content/cases-en/*.md`. |
| Posts dos cases | `src/content/stories/<case>/*.md` e `src/content/stories-en/<case>/*.md`. |
| Rascunhos | `draft: true` no frontmatter do case ou do post. Aparece só no `pnpm dev`. |

## Como gerar os PDFs do currículo

```
pnpm run build
```

O `build` roda o `astro build` e depois o `cv:pdf` (`scripts/resume-pdf.ts`), que sobe o `astro preview` sobre o `dist`, imprime `/resume` e `/en/resume` no Chrome headless em A4 e grava `allan-marcelino-resume-pt.pdf` e `allan-marcelino-resume-en.pdf` em `dist/` e em `public/`. Assim os PDFs publicados nunca ficam atrás do site.

- Só os PDFs, com o `dist` já gerado: `pnpm run cv:pdf`.
- Só o site, sem Chrome: `pnpm run build:site`.
- Chrome em outro caminho: `CHROME_PATH=/caminho/do/chrome pnpm run build`.
- `pnpm run deploy` faz o `build` completo antes do `wrangler deploy`.

Os PDFs em `public/` são versionados para os links de download funcionarem também no `pnpm dev`. Depois de mudar qualquer dado do currículo, rode o `build` e commite os PDFs novos.

## Indexação

O `pnpm run deploy` termina avisando o IndexNow (Bing, Yandex e outros) com todas as URLs do sitemap. Para enviar de novo sem deploy: `pnpm run indexnow`. O Google é pelo Search Console, com o sitemap `https://allanmxr.com.br/sitemap-index.xml`.
