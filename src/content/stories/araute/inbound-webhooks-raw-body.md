---
title: Webhook do provedor é gatilho, não prova de pagamento
summary: "O webhook de pagamento pode chegar repetido, fora de ordem, forjado ou nem chegar, e aplicá-lo direto pode creditar o lojista em dobro. Guardo cada aviso e confiro antes de mexer no saldo, sem perder nenhum evento."
project: araute
order: 2
tags: [Webhooks, HMAC, Hono, Cloudflare Queues, Pix]
---

Um comprador paga um Pix de R$ 89,90 às 14h02. Às 14h02 e alguns segundos, o provedor de Pix avisa a Araute por webhook. Às 14h03 chega o mesmo aviso de novo, porque a primeira resposta demorou. Às 14h05 chega um aviso de expiração da mesma cobrança, que estava na fila do provedor desde antes do pagamento. Se eu aplicar cada aviso como ele vem, o lojista recebe dois créditos e depois vê a cobrança marcada como expirada.

## O problema

O webhook é a forma mais barata e rápida de saber que um pagamento aconteceu. Mas ele não é confiável como fonte de verdade. Pode chegar duplicado, fora de ordem, depois de um período em que meu endpoint estava fora do ar, ou pode nem ter vindo do provedor. Aplicar o que chega abre espaço para crédito duplicado, para regressão de estado e para alguém forjar um pagamento.

## Por que não era trivial

A janela de retentativa de alguns provedores é curta, de poucas dezenas de minutos. Passado esse prazo, o evento só existe no painel do provedor. Então eu não posso me dar ao luxo de perder um evento que chegou.

Ao mesmo tempo, os esquemas de assinatura variam muito de provedor para provedor, e nem todos protegem contra replay com timestamp. A assinatura sozinha não basta para confiar no conteúdo.

E existe um detalhe que quebra a validação em silêncio. Um HMAC (código de autenticação calculado com um segredo compartilhado sobre a mensagem) só confere se for calculado sobre exatamente os mesmos bytes que o provedor assinou. Se o framework faz o parse do JSON e eu reserializo para validar, um espaço a menos ou uma ordem de chaves diferente bastam para a assinatura nunca mais bater.

## A solução

A rota de entrada é linear, e cada passo existe por um motivo.

### Corpo bruto primeiro

No Hono, leio o corpo como texto, antes de qualquer parse. O evento é gravado imutável, junto com os headers recebidos, ainda sem ter sido interpretado. Esse registro bruto me dá replay interno sem depender do provedor e deixa o adaptador evoluir sem perder eventos antigos: se eu corrigir o parser amanhã, consigo reprocessar o que chegou ontem.

### Assinatura sobre os bytes

Com o evento salvo, valido a assinatura sobre o texto exato recebido. Se ela não confere, marco o evento como inválido, não processo e registro um alerta. A resposta ao provedor continua sendo 2xx: responder 4xx só faria o remetente reenviar um conteúdo possivelmente forjado, e isso não ajuda ninguém.

### Responder rápido, processar na fila

A rota responde 2xx em poucos milissegundos e enfileira só o ID do evento no Cloudflare Queues. O trabalho pesado fica com o consumidor da fila, fora do tempo de resposta do provedor.

### O núcleo nunca lê o status cru

Cada provedor tem um adaptador que traduz o payload dele para um evento interno do meu vocabulário, como "pagamento confirmado" ou "pagamento expirado". Só esse evento interno chega à máquina de estados. Para eventos que movem dinheiro, o adaptador ainda consulta o estado atual na API do provedor antes de aplicar. Se a API discorda do webhook, a API vence. O webhook vira gatilho, não prova.

### Fora de ordem é descartado pela guarda

A máquina de estados recebe o estado atual e o evento e decide. Uma expiração que chega depois de a cobrança estar paga é recusada, em vez de virar um UPDATE. O evento é marcado como ignorado e o estado pago nunca regride.

### Dedupe na entrada, idempotência na aplicação

Uma restrição de unicidade por provedor e ID do evento barra o mesmo evento bruto duas vezes. Quando o provedor não manda um ID estável, uso o identificador ponta a ponta da liquidação Pix, o E2E ID que o Banco Central atribui a cada transação. Mas trato esse dedupe só como otimização. A garantia de aplicar uma vez está na idempotência da aplicação: mesmo que dois eventos do mesmo fato escapem do filtro, o efeito não se repete.

### Rede de segurança

O evento que nunca chegou não é problema desta rota. Ele fica para a conciliação periódica com o extrato do provedor.

## Um exemplo

O núcleo da rota, simplificado, fica assim. A ordem das linhas é a decisão de projeto.

```ts
app.post('/hooks/:provider', async (c) => {
  // read bytes before any JSON parse: the signature covers this exact text
  const rawBody = await c.req.text()
  const headers = Object.fromEntries(c.req.raw.headers)

  // persist first, so an event that arrived is never lost
  const event = await events.insertIfNew({ provider: c.req.param('provider'), rawBody, headers })
  if (!event) return c.body(null, 200) // duplicate, already stored

  if (!verifySignature(rawBody, headers, secretFor(event.provider))) {
    await events.markInvalid(event.id)
    alert('inbound_signature_invalid', { provider: event.provider })
    return c.body(null, 200) // a 4xx would only invite a resend
  }

  await queue.send({ eventId: event.id })
  return c.body(null, 200)
})
```

E a linha do tempo da cena de abertura passando por esse fluxo:

| Momento | Chega | O que acontece |
| --- | --- | --- |
| 14h02m05s | pagamento confirmado | salvo, assinatura válida, enfileirado; o consumidor consulta o provedor, confirma e aplica: cobrança paga |
| 14h03m10s | o mesmo aviso de novo | barrado pela unicidade do evento, responde 200 |
| 14h05m00s | expiração atrasada | salvo e enfileirado; a máquina de estados vê "paga + expirar", recusa a transição e o evento fica marcado como ignorado |
| 14h20m00s | nada | o Cron de conciliação passa pela cobrança, já está paga, nada muda |

## Resultado

Erro no consumidor não volta para o provedor, porque o 2xx já saiu. Ele fica na fila com retentativa e, esgotadas as tentativas, vai para uma fila de mensagens mortas com alerta, enquanto o evento bruto continua no banco para reprocessamento manual. O sistema não perde evento que chegou e tem um caminho de recuperação para o que não chegou.

## O que eu levo disso

Persistir antes de interpretar. O corpo bruto é o único registro fiel do que aconteceu, e tudo que derivo dele pode ser refeito. A segunda lição é tratar notificação como gatilho: ela me diz quando olhar, mas quem diz o que aconteceu é a fonte consultada e a máquina de estados que recebe o fato.
