---
title: Achalote
role: Criador
period: '2026, em construção'
summary: "Leilão de imóvel tem desconto real, mas a informação é espalhada e quase ninguém mostra se o lance compensa. Estou construindo um app que junta os lotes, calcula o desconto e avisa quando aparece um que vale a pena."
order: 5
stack: [Astro, TanStack Start, Hono, Kysely, Cloudflare Workers, D1, R2, Queues, Tailwind CSS]
links:
  - href: https://achalote.com.br
    label: Conhecer o Achalote
resume:
  summary: App que reúne imóveis de leilão da Caixa, calcula o desconto, guarda o histórico de preço e alerta lotes que valem a pena. Astro, TanStack Start, Hono e D1 em Cloudflare Workers.
  order: 1
---

## O problema

Leilão de imóvel tem desconto de verdade, mas a informação está espalhada, cada site com um formato, e quase ninguém mostra se o lance mínimo é bom negócio. A pessoa física desiste antes de começar. O Achalote junta os lotes, calcula o desconto sobre a avaliação, guarda o histórico de preço e avisa quando algo muda. Começa pelos imóveis da Caixa no Rio de Janeiro. O produto ainda não foi lançado: hoje existem pesquisa, especificação, design system e provas de conceito.

## Como está sendo construído

### Pesquisa antes de código

Baixei a lista oficial da Caixa (25.223 imóveis na data da coleta, 8.489 só no RJ) e medi preço, avaliação e desconto por modalidade e estado. Estudei o que já existe no mercado e fiz um levantamento jurídico e de custos. Daí saiu uma decisão de produto: o diferencial é o histórico de reduções, que só existe para quem guarda a lista todo dia. Por isso a coleta diária vem antes de qualquer tela. A pesquisa jurídica também definiu limites: nada de dado de devedor, de matrícula armazenada nem de fotos rehospedadas. Plano, não código: nada disso está em produção.

### Spikes que mudaram a arquitetura

Fiz 44 pontos de verificação, entre confirmar premissas e refutá-las (27 confirmados, 8 refutados, 6 parciais, 3 dependentes de decisão minha). O mais importante: eu achava que a Caixa barraria IP de datacenter e planejava coletar pelo GitHub Actions com proxy. Um Worker temporário na Cloudflare baixou as 27 listas e 45 páginas de detalhe, todas com 200, e o que a borda exige é o conjunto de cabeçalhos de navegador. A coleta passou a ser um Cron Trigger no Worker da API, sem proxy. Também refutei a ideia de usar o adaptador Astro em Pages e a transação interativa do Kysely no D1. A prova é de um dia: o critério de saída da fase 0 é sete dias seguidos sem intervenção.

### Detecção de mudança diária, desenhada em passos

A lista sai por volta das 22h de Brasília, confirmado pelo `Last-Modified`. O arquivo cru vai ao R2 antes de ser interpretado. O processamento valida formato e volume (abaixo de 70% do dia anterior vira "suspeito" e para), compara com o banco e gera eventos: listado, reduzido, modalidade mudou, financiamento mudou, saiu da lista e voltou. Um imóvel ausente por um dia fica "missing" antes de virar "delisted", para uma falha de coleta não gerar evento falso. Cada mudança relevante fecha um snapshot de preço e abre outro. Esse algoritmo está especificado em detalhe, ainda não implementado.

### Design system já existente

Esta parte já existe no repositório: tokens de cor e tipografia, tema claro e escuro e componentes (card de imóvel, preço, selo de desconto, gaveta de filtros), com uma rota de referência viva. Regras de produto viram regra de interface: todo número traz fonte e data, o risco aparece junto da oportunidade, o desconto arredonda para baixo e o custo para cima, e a interface nunca dá veredito do tipo "é seguro". Medi o contraste das cores com script.

## Decisões de arquitetura

- **Três Workers com papéis separados.** Astro para landing e SEO, TanStack Start para o sistema logado e Hono para a API REST, para o SEO ficar estático e rápido e o app evoluir sem afetar as páginas públicas.
- **D1 com Kysely e camada de repositório.** Como o D1 não tem transação interativa (provado no spike), a unidade de trabalho é o `batch`, que é atômico. Tabelas e colunas em inglês, com comentário em cada coluna conferido por teste.
- **Cache explícito.** Cache API nos Workers e limpeza por etiqueta, porque a regra de cache da zona não cobre resposta gerada por Worker.
- **Guardar o bruto antes de interpretar.** Se o parser errar, reprocesso o arquivo do R2 e o histórico não se perde.
- **Escopo recortado.** Fase 0 só coleta, a fase 1 é grátis e sem login, e cobrança só entra se a validação passar. A cobrança prevista usa a Araute.
