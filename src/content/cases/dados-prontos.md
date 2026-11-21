---
title: Dados Prontos
role: Criador
period: '2026'
summary: "Dado público no Brasil existe, mas fica preso em sites lentos e sem API, e quem precisa acaba copiando na mão. Mantenho 12 scrapers na Apify Store que entregam esses dados limpos, de leilões a licitações e diários oficiais."
order: 6
stack: [Python, Apify SDK, curl_cffi, httpx, Playwright, Pydantic, Astro, Tailwind CSS, Cloudflare Workers]
links:
  - href: https://dados.allanmxr.com.br
    label: Ver a vitrine
  - href: https://apify.com/allanmxr
    label: Perfil na Apify
resume:
  summary: 12 scrapers publicados na Apify Store que entregam dados públicos limpos em JSON, de leilões a licitações do PNCP e diários oficiais. Python, Playwright e Pydantic.
  order: 2
---

## O problema

Dado público no Brasil existe, mas está preso em sites lentos, paginados, sem API e cada um com um formato. Quem precisa monitorar licitação, leilão ou diário oficial acaba copiando na mão. Eu transformei isso em doze actors da Apify Store: o cliente configura filtros e recebe um dataset em JSON plano.

## Desafios e como resolvi

### Sites sem API: achar o endpoint interno

Quase nenhuma fonte tem API documentada. Em cada uma, abro o DevTools, vejo o que o próprio site chama e reproduzo a chamada. No PNCP, descobri a busca interna, os parâmetros (vários valores separados por `|`) e que `pagina * tam_pagina` não passa de 10 mil, senão a API devolve 400. Em outros casos o dado vem em JSON embutido na página (`__NEXT_DATA__`) ou numa lista CSV oficial, como a da Caixa. Prefiro sempre JSON interno a HTML. Resultado: menos requisições, menos quebra quando o layout muda.

### Cliente HTTP com escada de degraus

Cada fonte reage de um jeito. Montei um cliente por actor que começa no degrau mais barato e só sobe quando o anterior falha: requisição HTTP simples, depois a mesma requisição pelo Apify Proxy e navegador headless só quando a página depende de JavaScript. Medi o degrau mínimo de cada fonte e documentei. Quando o desafio exige interação humana, a fonte para e o status da execução diz isso. Não tento resolver CAPTCHA. Na maioria das fontes o degrau mínimo é o zero, e isso mantém o custo por execução na casa de centavos.

### Respeitar limites: ritmo, retentativa e backoff

429 e 5xx entram em retentativa com backoff e jitter. `Retry-After` é respeitado, com teto para uma fonte lenta não travar a execução. Quando a retentativa de várias requisições acordava junto, gerava rajada; passei a usar uma única pausa compartilhada por fonte. Cada fonte tem ritmo próprio (a Caixa roda em três identidades fixas, cerca de uma requisição por segundo cada). Falha de uma fonte fica isolada: as outras seguem e o resumo da execução registra o que aconteceu.

### Paginação com teto e duplicidade

Os tetos de cada site viram regra no código. A API da Superbid repetia e pulava ofertas até eu fixar `orderBy=id:asc` (cerca de 25% dos lotes sumiam). O Reclame Aqui limita cada consulta a 500 itens, então planejo a coleta pelas contagens do site e divido a busca por status, estado e problema até cada fatia caber. A OLX repete a página 100 para qualquer offset maior, e o PNCP estoura a 10 mil, então a busca é fatiada por UF e modalidade. Um lote quebrava o renderer da Mega Leilões e a página dava 500 sempre; releio com outra ordenação e a união recupera os vizinhos (353 de 359 lotes em SP, contra 311).

### Doze formatos, um schema plano

Cada actor junta várias fontes num mesmo item: dez leiloeiros de veículos, quatro portais de imóveis, quatro fontes de carros usados. Normalizo preço para número, datas para ISO com fuso de Brasília, comodidades para um vocabulário único e deduplico por identificador de origem. Em Chile, Colômbia e Argentina, o valor local ganha um campo em dólar com taxa de dois provedores (um de reserva) e a data da cotação. O schema do dataset tem título e exemplo em cada campo, para agentes de IA entenderem a saída.

### Enriquecer com a FIPE

Para mostrar o desconto de carro de leilão e usado, casei cada anúncio com a tabela FIPE. O casamento vira marca por tokens, código do ano modelo, regras duras de motor e câmbio e uma nota que combina Jaccard e `difflib`. Os resultados ficam em cache por caminho, porque a API sem token tem teto diário. Ajustes que os testes pediram: "turbo" precisa contar como termo distintivo e versões como "premier" precisam de mapeamento próprio.

### Modo monitor: só o que é novo

Licitações e diários oficiais guardam o estado entre execuções num key-value store nomeado. O monitor de licitações grava os identificadores já vistos por 180 dias, e só entra no estado o que foi de fato entregue. O de diários relê dois dias antes da marca d'água, e usa 24 h de sobreposição no Querido Diário para pegar edição indexada com atraso. O estado é salvo a cada lote cobrado, então um crash não cobra duas vezes.

### Índice próprio para 74 milhões de CNPJs

As APIs de busca de empresas filtram pouco. Gerei um índice dos dados abertos da Receita: 74,2 milhões de estabelecimentos em cerca de 11 mil chaves compactadas, só com campos de filtro. A busca filtra antes de consultar o detalhe, então o cliente só paga pelo que casa. Um workflow mensal no GitHub Actions refaz o índice e sobe só as chaves que mudaram, com manifesto de hashes gravado por último, para o actor nunca misturar dois snapshots.

### Testes e custo medido

Cada actor tem roteiro E2E com prints e números reais, testes de parsing sem rede e conferência contra o total que o site mostra. Medi o custo por mil itens na plataforma (em geral entre 0,01 e 0,02 dólar por mil itens) e usei isso para calibrar memória e preço. Um teste de carga meu levou um IP a ser banido por uma hora; o actor caiu sozinho para a fonte seguinte, e desde então não faço teste de carga contra API de terceiro.

## Decisões de arquitetura

- **Um actor por tema, várias fontes por actor.** O cliente quer "leilões de carro", não "Copart". Um schema único vale mais que um scraper por site.
- **Só fonte primária e dado público.** Tirei um agregador concorrente por risco de concorrência desleal. Não coleto CPF, nome de devedor nem de pessoa física, e mascaro CPF em texto livre.
- **Filtrar antes de cobrar.** Cobrança por item entregue (pay per event), com `maxItems` respeitado e cota dividida entre fontes, devolvida quando uma fonte seca.
- **Diagnóstico em cada execução.** `REQUEST_LOG` e `RUN_SUMMARY` registram status, tipo de bloqueio e tempo por host, o que torna visível quando uma fonte mudou.
- **Vitrine estática.** Site em Astro e Tailwind, no Cloudflare Workers, com calculadora de leilão e lista de imóveis da Caixa.
