---
title: "Miniaturas de página numa fila: quando capturar, quando desistir e quando não escrever"
summary: "Ao levar a captura de miniaturas para o navegador remoto da Cloudflare, os testes mostraram foto em branco, foto de tela de erro e páginas que nunca dariam certo indo para a fila de falhas. Desenhei quando capturar, quando desistir e como evitar trabalho duplicado, para a fila de falhas só receber o que merece investigação."
project: great-softwares
order: 9
tags: [Cloudflare Queues, Browser Rendering, Retry, Idempotência, Cloudflare Workers]
---

Na galeria do Great Pages, cada página, bloco e template aparece com uma miniatura. Para quem usa, isso é invisível. Para quem constrói, é um consumidor de fila que abre um navegador para cada item. Ao testar a troca do motor de captura, apareceram miniaturas em branco, outras mostrando a página de erro "muitas requisições" em vez do conteúdo, e páginas que nunca iam dar certo esgotando as tentativas até a fila de mensagens mortas, onde vão as mensagens que esgotaram as tentativas.

## O problema

O pipeline é um consumidor de fila. Cada mensagem traz o endereço de uma prévia. O consumidor abre a prévia num navegador, tira o print, sobe a imagem para o armazenamento e grava a referência no banco. O trabalho era trocar uma sessão própria de Puppeteer pela ação pronta de screenshot do Browser Run, o serviço de navegador remoto da Cloudflare. A troca parecia direta, mas os testes mostraram quatro modos de falha que o desenho precisava cobrir: foto em branco, foto de página de erro, mensagens queimando todas as tentativas e uma mesma mensagem processada duas vezes.

## Por que não era trivial

- **"Página pronta" muda de caso para caso.** Uma página recém-criada não tem nenhum bloco. Uma página feita só com HTML personalizado também não tem a estrutura padrão. Esperar um seletor de bloco nunca terminava nesses casos.
- **Falha determinística não melhora com retry.** Uma página que redireciona por script, tem certificado inválido ou nunca renderiza falha igual na primeira e na décima tentativa. Com a política padrão, a fila tentaria dez vezes antes de desistir.
- **O navegador remoto sai de poucos IPs compartilhados.** Em lote, as capturas parecem um ataque para as regras de rate limit da própria zona de prévias, e o print sai da página de bloqueio.
- **`Promise.race` não cancela quem perde.** Quando o timeout da mensagem vence, a captura e a escrita continuam rodando e podem terminar depois que a mensagem já voltou para a fila.
- **Código do usuário pode travar a página.** Em páginas com HTML e scripts escritos pela pessoa, um laço infinito trava a captura.

## A solução

### Um gate de renderização que também filtra erro

O consumidor espera um seletor que existe em toda prévia de página, mesmo vazia, e um seletor de bloco no caso de blocos e templates. A página de bloqueio e as páginas de erro não têm esse seletor, então a captura falha em vez de entregar uma foto errada. Do lado da prévia, uma falha ao ler o conteúdo passou a devolver erro em vez de página vazia, para que um soluço passageiro não vire uma miniatura em branco permanente.

### Três tentativas, depois descarte

As duas primeiras tentativas esperam a rede ficar quase ociosa. A terceira se contenta com o evento de carregamento, porque páginas com analytics sempre ativo nunca ficam ociosas. Um 429 volta para a fila respeitando o `retry-after`, com folga extra. Qualquer outra falha volta até a terceira tentativa, e na terceira a mensagem é **confirmada e descartada**. O atraso entre tentativas é exponencial com até 5 segundos de jitter, para que um lote limitado junto não volte junto.

### O tráfego da casa reconhecido pelas regras

As regras de rate limit da zona de prévias passaram a reconhecer as capturas do próprio consumidor e deixá-las de fora. Sem essa identificação configurada, o comportamento volta ao padrão e a regra vale normalmente.

### Guarda contra execução tardia

O processamento corre contra um timeout calculado a partir dos timeouts da própria ação de captura, com margem. Como o timeout não cancela a captura, envolvi a mensagem num objeto que lembra se ela já foi resolvida. Depois de cada etapa longa, o consumidor confere essa marca. Se o timeout já devolveu a mensagem à fila, a execução atrasada para ali e não sobe imagem nem escreve no banco por cima de uma nova entrega.

### Última tentativa em modo seguro

Na tentativa final de uma página com código do usuário, a URL da prévia ganha um parâmetro que desliga esse código. Se foi ele que travou as tentativas anteriores, ainda sai uma miniatura da estrutura da página.

### Menos coisa para carregar

O consumidor bloqueia hosts de analytics e anúncios, recusa mídia pesada e salva o print em JPEG. A escrita no banco exige a conta dona do registro na condição do `UPDATE`, o que mantém o isolamento entre contas mesmo se uma mensagem vier errada.

## Um exemplo

A guarda contra execução tardia, em versão mínima:

```ts
class GuardedMessage {
  private settled = false;
  constructor(private readonly msg: Message<CaptureJob>) {}

  get settledAlready() { return this.settled; }

  retry(delaySeconds: number) {
    if (this.settled) return;
    this.settled = true;
    this.msg.retry({ delaySeconds });
  }

  ack() {
    if (this.settled) return;
    this.settled = true;
    this.msg.ack();
  }
}

async function capture(message: GuardedMessage) {
  const image = await takeScreenshot(message.body.url);
  // O timeout pode ter vencido durante o print e reenfileirado a mensagem.
  if (message.settledAlready) return;
  await uploadImage(image);
  if (message.settledAlready) return;
  await saveThumbnailReference(message.body);
  message.ack();
}
```

E como uma mensagem problemática atravessa a política nova:

| Tentativa | Espera da página | Resultado | Ação |
| --- | --- | --- | --- |
| 1 | rede quase ociosa | 429 com `retry-after: 20` | volta em 20 s mais folga |
| 2 | rede quase ociosa | timeout, script do usuário em laço | volta com atraso exponencial e jitter |
| 3 | carregamento, código do usuário desligado | print da estrutura | sobe, grava, confirma |

Se a terceira também falhasse, a mensagem seria confirmada e descartada, sem ir para a fila de mortas.

## Resultado

A fila de mensagens mortas não recebe falhas determinísticas. Páginas vazias têm miniatura, o consumidor não é barrado pelas regras da própria casa, e uma captura lenta não escreve por cima de uma mensagem que já foi reentregue.

## O que eu levo disso

Todo consumidor de fila precisa responder a uma pergunta: o que acontece na última tentativa? Retry de falha determinística é só um jeito caro de adiar o descarte. E timeout com `Promise.race` não interrompe nada, então toda escrita depois de uma etapa longa precisa conferir se a mensagem ainda é dela.
