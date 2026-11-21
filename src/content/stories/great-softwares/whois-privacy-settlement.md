---
title: Privacidade WHOIS que o registrador demora horas para confirmar
summary: "A privacidade WHOIS às vezes demora horas para ligar, e enquanto isso os dados pessoais do cliente ficam expostos. Separei instabilidade, recusa definitiva e erro nosso, e cada caso agora se resolve ou gera alerta no tempo certo."
project: great-softwares
order: 20
tags: [OpenSRS, Cloudflare Workflows, Cron, Backoff, TypeScript]
---

Uma pessoa registra `estudiomarina.com` e paga a mais pela privacidade WHOIS, o serviço que esconde nome, e-mail e telefone do titular na consulta pública de domínios. O registro termina em segundos. A privacidade, não. Logo depois do registro, o registrador responde que ela está "sendo ligada". Dez minutos depois, às vezes ainda está. Enquanto isso, quem consultar o domínio vê os dados pessoais dela.

## O problema

O registrador liga a privacidade de forma assíncrona. Ao consultar logo depois do registro, eu posso receber quatro respostas: confirmada, pendente, não aplicada, ou um erro que não diz nada com certeza.

Se eu desisto cedo, a cliente paga por um serviço que não recebeu e fica com os dados expostos. Se insisto para sempre, um domínio fica preso numa fila de tentativas que nunca termina, queimando chamadas ao registrador.

## Por que não era trivial

O difícil era que três situações diferentes chegavam como o mesmo "falhou".

1. **Instabilidade do registrador.** Timeout, limite de taxa, pedido ainda em processamento. Passa sozinha.
2. **Recusa definitiva.** O TLD (a terminação, como `.com` ou `.io`) não suporta privacidade. Nunca vai passar, não importa quantas vezes eu tente.
3. **Erro nosso.** Credencial vencida, permissão errada no perfil de revendedor. Parece uma recusa, mas é um problema de operação.

Tratar as três igual dá o pior resultado em cada caso. Desistir de uma instabilidade deixa a cliente exposta. Insistir numa recusa definitiva gasta tentativas e prazo à toa. E o terceiro caso é o mais traiçoeiro: concluir "não aplicado" porque o nosso token venceu por uma hora seria registrar como falha do registrador um erro que foi nosso. Como a rotina processa domínios em lote, isso aconteceria com dezenas de uma vez.

## A solução

### Duas fases, dois relógios

1. **Fase rápida**, dentro do Workflow de provisionamento (o Cloudflare Workflows executa passos duráveis que sobrevivem a reinícios). Logo depois do registro, leio o estado. Se está pendente, o passo dorme dois minutos e lê de novo. Se não foi aplicada, tento religar até três vezes. Isso resolve o caso comum em minutos.
2. **Fase lenta**, num cron a cada 15 minutos. Pega o que a fase rápida não resolveu e continua com backoff exponencial: 2 minutos, 4, 8, até um teto de 1 hora entre tentativas. Para em oito tentativas ou seis horas, o que vier primeiro.

O prazo de seis horas conta a partir de um carimbo de início gravado uma única vez, na primeira verificação. Um primeiro desenho contava a partir da data da última verificação, mas essa data é reescrita a cada tentativa: o prazo andaria junto com o tempo e nunca venceria. Por isso o início ganhou um carimbo próprio. Uma restrição `CHECK` no PostgreSQL garante hoje que o carimbo de início e o estado nasçam juntos.

### Lease por domínio

Antes de tentar, o cron reserva o domínio por 10 minutos com um `UPDATE` condicional. Se duas execuções do cron se sobrepõem, só uma ganha a reserva e a outra pula o domínio. Ninguém gasta tentativa em dobro.

### A integração devolve o motivo, não só o veredito

A leitura e a ativação devolvem duas coisas: o veredito (confirmada, pendente, não aplicada, desconhecida) e o tipo de falha (transitória, não elegível, defeito do operador). Um mapa liga cada código de erro da integração com a OpenSRS a uma dessas três categorias. O mapa é um `Record` sobre a união de todos os códigos, então um código novo quebra a compilação até alguém decidir onde ele cai.

### Uma função pura decide

Toda a política mora numa função que recebe veredito, falha, tentativas, início e agora, e devolve o desfecho. Sem banco, sem rede, sem relógio escondido. As regras:

- confirmada encerra com sucesso;
- não elegível encerra na hora, porque é um fato observado;
- transitória e defeito do operador continuam tentando até o teto, para que um erro nosso passageiro não vire veredito contra a cliente;
- no fim do prazo, os desfechos se separam: "bloqueado" quando a última falha foi nossa (urgente, alguém precisa agir) e "não resolvido" quando o registrador só oscilou.

Os dois desfechos ruins geram auditoria e alerta para a operação, com textos diferentes.

## Um exemplo

A função, simplificada:

```ts
type Verdict = "CONFIRMED" | "PENDING" | "NOT_APPLIED" | "UNKNOWN";
type Failure = "TRANSIENT" | "NOT_ELIGIBLE" | "OPERATOR_DEFECT" | null;

const MAX_ATTEMPTS = 8;
const DEADLINE_MS = 6 * 60 * 60 * 1000;
const delaySeconds = (attempt: number) => Math.min(120 * 2 ** (attempt - 1), 3600);

function decide(v: Verdict, f: Failure, attempts: number, startedAt: Date, now: Date) {
  if (v === "CONFIRMED") return { done: true, outcome: "confirmed" };
  // A definitive refusal must close before anything else, or it burns every retry.
  if (f === "NOT_ELIGIBLE") return { done: true, outcome: "not_applied" };

  const expired = now.getTime() - startedAt.getTime() >= DEADLINE_MS || attempts >= MAX_ATTEMPTS;
  if (!expired) {
    return { done: false, retryAt: new Date(now.getTime() + delaySeconds(attempts + 1) * 1000) };
  }
  if (v === "NOT_APPLIED") return { done: true, outcome: "not_applied" };
  return { done: true, outcome: f === "OPERATOR_DEFECT" ? "blocked" : "unresolved" };
}
```

E três domínios passando por ela:

| Domínio | Linha do tempo | Desfecho |
| --- | --- | --- |
| `a.com` | t=0 pendente, t=2min confirmada no Workflow | Confirmada em 2 minutos |
| `b.io` | Workflow esgota as três tentativas, o cron retoma nas passadas seguintes com intervalos crescentes | Confirmada na terceira tentativa do cron, em menos de uma hora |
| `c.xyz` | Primeira leitura volta "TLD não suporta" | Não aplicada na hora, sem gastar tentativa |

A linha comentada no código tem história. Numa versão anterior da função, a checagem de "não elegível" ficava aninhada dentro de outro ramo, que não era alcançado nesse caso, e um domínio como `c.xyz` gastaria as oito tentativas e seis horas antes de fechar. Como a decisão é uma função pura, o caso acrescentado à tabela de testes mostrou o erro, e a correção foi mover uma linha para o topo.

## Resultado

O caso comum resolve em minutos, o caso lento em até seis horas e o caso impossível fecha na primeira resposta. A operação recebe dois tipos de alerta distintos, um que pede ação imediata e outro que só pede acompanhamento. E a política inteira cabe numa função testada linha a linha, sem mock de banco nem de rede.

## O que eu levo disso

Modelo falha como dado, não como exceção. Quando a falha tem tipo, o mesmo código decide quando insistir, quando parar e quem precisa ser avisado. E separo a decisão (função pura) do efeito (banco, rede, cron): é isso que deixa um bug de regra de negócio aparecer num teste de tabela em vez de aparecer em produção.
