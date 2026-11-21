---
title: "Pix Automático entre dois provedores: webhook, timeout e faxina disputando a mesma contratação"
summary: "A confirmação do Pix Automático chega repetida, fora de ordem e às vezes depois de o cliente desistir, o que podia duplicar a assinatura ou perder o pagamento. Fiz o fluxo resistir a isso e uma auditoria diária avisar o que escapar."
project: great-softwares
order: 11
tags: [Pix Automático, Stripe, Idempotência, Saga, Webhooks]
---

Imagine uma cliente que escolhe pagar a assinatura do Great Apps com Pix Automático. Ela escaneia o QR code, abre o app do banco e autoriza. Enquanto isso, na tela do Great Apps, ela se cansa de esperar e clica em "voltar". Dez segundos depois, o provedor de Pix manda o webhook avisando que ela autorizou. Dois segundos depois, manda de novo. O sistema precisa decidir, sem ajuda humana, se cria a assinatura, se cria uma vez só e o que fazer se a autorização chegar depois que a tela já desistiu.

## O problema

Pix Automático funciona com um mandato: uma autorização que o cliente dá no app do banco para que um recebedor debite valores recorrentes, dentro de um teto, sem nova confirmação a cada ciclo. No Great Apps, o mandato vive no provedor de Pix, mas a assinatura e as faturas continuam na Stripe, que é a fonte de verdade do faturamento. O dinheiro que entra por Pix é conciliado na Stripe como pago por fora.

São três estados que precisam concordar: o mandato no provedor de Pix, a assinatura na Stripe e uma linha local que acompanha a contratação. Quem avisa que o cliente autorizou é um webhook, e webhook pode chegar duplicado, atrasado, fora de ordem ou depois que o cliente desistiu.

## Por que não era trivial

Cada sistema falha por conta própria. Se o commit (o passo que cria a assinatura na Stripe) cai no meio, posso ficar com dinheiro debitado sem assinatura, ou com assinatura criada em cima de um mandato revogado. Não existe transação que abrace o provedor de Pix, a Stripe e o meu banco ao mesmo tempo.

Havia também uma regra de valor pouco óbvia. O provedor de Pix só trata o mandato como de valor variável se o valor mínimo for estritamente menor que o valor do mandato. Se forem iguais, o campo de valor variável é ignorado e eu perco a capacidade de ajustar o valor depois. Isso importa quando há desconto no primeiro ciclo: o cliente autoriza o teto do valor cheio, paga o primeiro mês com desconto, e o valor do mandato só pode subir para o recorrente depois que essa primeira fatura for paga.

E três processos diferentes disputam a mesma linha: o webhook que quer fazer o commit, o timeout que quer abandonar a contratação e uma faxina periódica que limpa o que ficou parado.

## A solução

### Uma linha com fases explícitas

Cada contratação ou troca de forma de pagamento vira uma linha com uma fase: `creating`, `awaiting_authorization`, `committing`, `completed`, e as saídas `expired`, `rejected` e `manual_review`. Toda mudança de fase é um compare-and-set: um `UPDATE` que só acontece se a fase atual ainda for a que eu li. Se o `UPDATE` não afeta nenhuma linha, outro processo chegou antes, e eu saio sem nenhum efeito colateral.

### Lease de commit

Só cria a assinatura quem consegue mover a linha para `committing`. Essa fase carrega o horário em que foi reivindicada. Se o commit lança erro, eu marco o lease como liberado explicitamente, para a próxima entrega do webhook retomar. Se o worker morre, o lease vence sozinho depois de dez minutos. O timeout e a faxina respeitam a mesma condição, então ninguém expira uma linha enquanto ela está sendo commitada.

### Pagamento em linha encerrada não some

Se um pagamento chega numa linha já expirada ou rejeitada, eu não descarto. Devolvo falha ao webhook, o evento fica estacionado e entra na conciliação. Dinheiro recebido sempre tem destino rastreável.

### Efeitos antes de fechar

Avisos para outros produtos, como ativar um domínio comprado junto, são enfileirados antes de a linha virar `completed`. Se o enfileiramento falha, o commit inteiro se repete. Se eu fechasse a linha primeiro, uma falha ali perderia o evento para sempre.

### Um auditor diário

Um cron audita todo dia as assinaturas ativas em Pix Automático contra o estado do mandato: valor divergente, mandato cancelado com assinatura ativa, débito sem fatura correspondente. Para respeitar o limite de chamadas do provedor, ele divide o conjunto em fatias determinísticas pelo dia: cada execução olha uma fatia, e o ciclo completo cobre todo mundo. Ele nasceu em modo de simulação, aplicando correção de status só quando uma configuração mandava. Depois que o fluxo principal amadureceu, tirei dele o poder de escrever no provedor: hoje ele audita e alerta a operação de cobrança, e quem corrige é o fluxo normal.

## Um exemplo

O coração é a transição condicional. Em TypeScript, com nomes genéricos:

```ts
const LEASE_MS = 10 * 60 * 1000;

async function claimCommit(row: PendingRow): Promise<boolean> {
  const s = row.state;
  const leaseFree =
    s.phase !== "committing" ||
    s.leaseReleasedAt != null ||
    Date.now() - Date.parse(s.committingAt) > LEASE_MS;
  if (!["awaiting_authorization", "committing"].includes(s.phase) || !leaseFree) return false;

  // o WHERE repete o que eu li: se alguém mudou a linha no meio, ninguém é atualizado
  const updated = await db.updateWhere(
    { id: row.id, phase: s.phase, committingAt: s.committingAt ?? null },
    { phase: "committing", committingAt: new Date().toISOString(), leaseReleasedAt: null },
  );
  return updated === 1;
}
```

E uma linha do tempo com a cliente da abertura:

| Tempo | Evento | O que acontece na linha |
|---|---|---|
| t=0 | QR code gerado | fase `awaiting_authorization` |
| t=40s | cliente fecha a tela | nada muda; a linha só expira no timeout |
| t=52s | webhook de autorização (entrega 1) | claim vence, fase `committing` |
| t=54s | webhook de autorização (entrega 2) | claim perde (lease ocupado), responde "tente depois" |
| t=55s | assinatura criada na Stripe, aviso enfileirado | fase `completed` |
| t=2min | reentrega 2 | lê `completed`, encerra sem efeito |
| t=30min | timeout tenta expirar | compare-and-set falha, a linha já está concluída |

Se o worker tivesse morrido em t=54s, a reentrega depois de dez minutos encontraria o lease vencido e terminaria o commit.

## Resultado

O fluxo aguenta entrega duplicada, atrasada e fora de ordem sem criar assinatura em dobro e sem perder pagamento. As corridas entre webhook, timeout e faxina se resolvem no banco, não em suposições sobre a ordem dos eventos. O auditor diário pega o que escapa, como uma divergência de valor no mandato, e avisa a operação antes de virar reclamação.

## O que eu levo disso

Em saga entre sistemas externos, tentar prever todas as ordens de chegada dos webhooks é uma batalha perdida. Uma linha de estado com compare-and-set por fase e um lease com vencimento resolvem a maioria dos casos sem que eu precise enumerá-los.

E um auditor que começa só observando é a forma mais barata de descobrir os casos que eu não pensei. Dar a ele poder de escrita é uma decisão separada, e no meu caso a decisão certa foi tirar esse poder depois.
