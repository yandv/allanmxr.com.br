---
title: "Portar o clonador de páginas para Workers, onde cada comando ao navegador é uma ida e volta de rede"
summary: "O clonador que traz páginas de outros construtores precisava sair de um servidor próprio para a Cloudflare sem mudar nada para quem o usa. Migrei com o mesmo contrato e reduzi as idas e voltas ao navegador até o tempo ficar aceitável."
project: great-softwares
order: 5
tags: [Cloudflare Workers, Browser Rendering, Puppeteer, Migração, Performance]
---

Uma pessoa que já tem uma landing page feita em outro construtor quer migrar para o Great Pages sem remontar tudo. Ela cola o endereço, espera um pouco e recebe a página no editor: blocos, textos, formulários, imagens, popups e até os estilos de hover. Quem faz isso é o clonador, um serviço que abre a página num navegador de verdade, lê o DOM e traduz para o formato do editor. Ele rodava em Node, com Express, Puppeteer e PostgreSQL, num container fora da Cloudflare. Minha tarefa era levá-lo para um Worker sem mudar o contrato com quem o chama.

## O problema

Eram dois objetivos. Primeiro, equivalência: mesmas rotas, mesmos payloads, mesmo resultado. Segundo, a página deveria sair direto no formato novo do editor, sem passar pelo formato antigo e por um conversor depois.

## Por que não era trivial

- **Milhares de linhas de scraping**, com rotinas por tipo de elemento e por construtor de origem. Cada uma lê o DOM de um jeito.
- **O navegador deixa de ser um processo local.** No Browser Rendering da Cloudflare, cada comando do protocolo de depuração do Chrome (CDP) é uma ida e volta pela rede. Um laço que lê um elemento por vez, barato num container, vira minutos.
- **Há limite de abertura de navegadores por segundo**, com 429 acima dele, e um dos construtores de origem respondia 403 ao user agent padrão do navegador remoto.
- **Trabalho em segundo plano não sobrevive num Worker.** No container, gravações de imagem disparadas sem esperar terminavam porque o processo continuava vivo depois da resposta. Num Worker, o que não é aguardado nem entregue a `waitUntil` simplesmente para quando a resposta sai.

## A solução

### Equivalência antes de otimização

Fiz um mapa de troca peça por peça. Express virou o roteador da casa. O validador de requisições virou uma implementação própria, que conferi contra a biblioteca original com 120 mil entradas aleatórias sem nenhuma diferença de resultado. O driver `pg` virou Hyperdrive (o pool de conexões da Cloudflare para bancos externos), `axios` virou `fetch` e o serviço HTTP de armazenamento virou binding direto do R2. O Worker não tem rota pública: só é chamado por service binding.

Cada requisição abre um navegador e o fecha no `finally`, antes de responder. Popups usam dois contextos isolados, desktop e mobile. O 403 sumiu quando passei a usar o user agent de um Chrome comum de Windows.

Tudo o que antes rodava solto passou a ser aguardado antes da resposta. Registrei cada uma dessas mudanças numa lista de divergências intencionais, para que ninguém confunda a diferença com regressão.

### Cortar idas e voltas

Essa foi a maior parte do trabalho, em duas rodadas de medição:

- Posicionei o Worker perto do navegador remoto, para baixar a latência de cada mensagem.
- Troquei laços que pediam um handle por elemento por uma única chamada `evaluate` por bloco, que devolve botões, textos, imagens, formulários, vídeos e sliders numa passada.
- A captura de hover passou a usar duas mensagens por elemento em vez de várias.
- Troquei sonos fixos por esperas por condição: a página está estável quando não há mutação de DOM por 500 ms, nenhuma animação finita rodando, fontes carregadas e imagens visíveis completas. O teto continuou o mesmo de antes, e laços sem limite ganharam um teto de 10 segundos. Essas esperas rodam no Worker e consultam a página com mensagens curtas, porque uma aba em segundo plano limita `setTimeout` a cerca de 1 segundo e uma espera dentro da própria página estouraria o prazo.
- Bloqueei na rede rastreadores, pixels de anúncio e widgets de chat, com exceções para o que a página precisa para renderizar.
- Paralelizei só o que não muda o resultado: imagens de fundo de 4 em 4 e elementos de 3 em 3, com a ordem final idêntica à sequencial.

### Saída nativa

O documento é gerado direto no formato novo, com o mesmo parser do conversor da API, e o design system da página é criado com o mesmo hash de tema que a API usa, conferido com valores de referência calculados pelo código original.

## Um exemplo

Um bloco com 40 elementos, numa rede em que cada mensagem CDP leva uns 30 ms de ida e volta. Antes, o código lia um elemento por vez:

```ts
// Antes: 1 mensagem para listar + 3 por elemento
const handles = await page.$$('[data-block="b1"] > *');
for (const h of handles) {
  const tag = await h.evaluate((el) => el.tagName);
  const text = await h.evaluate((el) => el.textContent);
  const box = await h.boundingBox();
  items.push({ tag, text, box });
}
```

São 1 + 40 × 3 = 121 mensagens, cerca de 3,6 segundos só de rede para um bloco. Depois, uma chamada lê tudo dentro da página e devolve um array serializável:

```ts
// Depois: 1 mensagem por bloco
const items = await page.evaluate((selector) =>
  Array.from(document.querySelectorAll(selector), (el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, text: el.textContent, box: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }), '[data-block="b1"] > *');
```

Uma mensagem, uns 30 ms. Numa página com dezenas de blocos, essa diferença separa um clone que termina de um que estoura o tempo.

## Resultado

Na medição local, o clone de uma página real ficou em cerca de 57 segundos, a captura de hover em cerca de 3 e a de popups em cerca de 21. Uma suíte de ponta a ponta com páginas reais dos construtores suportados cobre os contratos de sucesso, falha e validação, e a API para quem chama continuou a mesma.

## O que eu levo disso

Com navegador remoto, conte as idas e voltas antes de olhar CPU: a latência está nas mensagens, não no processamento. E, ao portar um sistema, mantenha uma lista escrita das divergências intencionais. É ela que explica o comportamento de amanhã quando alguém comparar com o antigo.
