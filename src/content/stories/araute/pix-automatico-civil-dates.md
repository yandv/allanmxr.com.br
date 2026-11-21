---
title: Garantir que o dia de cobrança do Pix Automático chegue ao provedor no dia certo
summary: "O provedor do Pix Automático lê a data no horário de Brasília, e meia-noite UTC cai no dia anterior por lá, o que pode empurrar a cobrança para fora do prazo regulatório. Passei a tratar datas como dia do calendário de ponta a ponta, e essa classe de erro ficou fechada no sistema inteiro."
project: araute
order: 5
tags: [Pix Automático, Datas e fusos, PostgreSQL, TypeScript, Assinaturas]
---

Imagine um lojista que cria uma assinatura mensal com Pix Automático, com cobrança todo dia 13. O assinante autoriza no app do banco e tudo parece certo. No painel do provedor de Pix, porém, a cobrança aparece agendada para o dia 12. Nenhum erro, nenhum alerta, só um dia a menos. E esse dia a menos importa, porque o Pix Automático tem prazos regulatórios rígidos.

## O problema

O Pix Automático é a versão recorrente do Pix: o pagador autoriza uma vez um mandato (a permissão para que um recebedor debite valores na conta dele numa certa frequência) e as cobranças seguintes acontecem sem nova ação. Para agendar o débito, o provedor recebe a data da cobrança.

A primeira versão da integração enviava essa data como `2026-08-13T00:00:00Z`, ou seja, meia-noite em UTC, e o dia a menos apareceu ainda no ambiente de testes do provedor. O provedor interpreta a data no horário de Brasília, e meia-noite UTC é 21h do dia 12 por lá. Ele lê o dia anterior.

## Por que não era trivial

Primeiro, a janela regulatória. A instrução de cada cobrança automática precisa sair entre 10 e 2 dias corridos antes da liquidação. Agendar dentro dos últimos dois dias é rejeitado pelo banco do pagador. Um dia de deslocamento pode empurrar a cobrança para dentro da zona proibida.

Segundo, o primeiro ciclo tem caminhos diferentes. Se há valor a cobrar já na adesão, o mesmo QR que cria o mandato também cobra o primeiro ciclo. Se a assinatura começa com período de teste, o mandato só autoriza, e o início precisa ficar a pelo menos três dias. Cada caminho deriva uma data diferente, e cada derivação é um lugar onde o fuso pode escapar.

Terceiro, e mais traiçoeiro: em UTC o bug some. Uma suíte de testes rodando em UTC passa inteira, porque ali meia-noite UTC e o dia local coincidem.

## A solução

### Classificar cada data antes de escrever código

Comecei com uma pergunta para cada campo de data: duas pessoas em fusos diferentes, olhando o mesmo registro no mesmo segundo, deveriam ver valores diferentes? Se não, é uma **data civil**. A competência de agosto é agosto em Tóquio e em Rio Branco, e o dia de vencimento é o dia de vencimento. Se sim, é um **instante**, como o momento em que um pagamento foi confirmado.

### Data civil é texto do início ao fim

Data civil vive como `AAAA-MM-DD`. No PostgreSQL, a coluna é `date`, nunca `timestamptz`. Desliguei o parser do driver para esse tipo, então a data volta do banco como string, sem virar `Date` do JavaScript no caminho. Na API ela sai como a mesma string, sem sufixo de fuso.

Comparar duas datas civis é comparar strings. Aritmética (somar meses, achar o último dia do mês) passa por funções que validam o calendário real, porque uma regex de formato aceita `2026-02-31` e o banco não.

### Instante vira dia só com fuso explícito

Quando um instante precisa virar dia, o fuso é sempre declarado. Em SQL, `AT TIME ZONE 'America/Sao_Paulo'`. Em TypeScript, uma única função faz essa conversão, e nenhum outro lugar improvisa.

### Uma única conversão de volta, ao meio-dia

Alguns provedores exigem data com hora. Nesse único ponto, na borda, a data civil vira instante, e sempre ao meio-dia UTC. Meio-dia UTC cai no mesmo dia de calendário em qualquer fuso habitado do Brasil e, na prática, em quase todo o mundo, então nenhuma interpretação local troca o dia.

### A âncora do ciclo

O dia de cobrança que o assinante percebe é local. Guardo o dia-âncora (de 1 a 31) e derivo cada período resolvendo primeiro o dia local e só depois o instante. Em meses curtos vale o menor entre o dia-âncora e o último dia do mês, então uma assinatura do dia 31 cobra em 28 ou 29 de fevereiro. Nunca somo 30 vezes 24 horas.

## Um exemplo

Uma assinatura com âncora no dia 13, criada às 22h30 de 12 de agosto em São Paulo. Veja o que cada abordagem produz:

| Abordagem | Valor enviado | O provedor lê (Brasília) |
| --- | --- | --- |
| `new Date('2026-08-13').toISOString()` | `2026-08-13T00:00:00.000Z` | 12/08, 21h |
| "Hoje" via `toISOString().slice(0, 10)` às 22h30 | `2026-08-13` | um dia adiantado: ainda é 12 em Brasília, e o prazo de D-2 sai errado |
| Data civil + meio-dia na borda | `2026-08-13T12:00:00.000Z` | 13/08, 09h |

O código da borda fica pequeno, porque toda a disciplina está antes dele:

```ts
type CivilDate = string // 'YYYY-MM-DD', nunca Date

function toLocalDate(instant: Date, timeZone = 'America/Sao_Paulo'): CivilDate {
  // en-CA formata como YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(instant)
}

function toProviderDateTime(day: CivilDate): string {
  // meio-dia UTC não troca de dia em nenhum fuso brasileiro
  return `${day}T12:00:00.000Z`
}

const chargeDay: CivilDate = '2026-08-13'
toProviderDateTime(chargeDay) // '2026-08-13T12:00:00.000Z'
toLocalDate(new Date('2026-08-13T01:30:00Z')) // '2026-08-12'
```

E o teste que pega a classe inteira de erro roda num horário que já é o dia seguinte em UTC:

```ts
test('charge day survives the 21h to 23h59 window', () => {
  vi.setSystemTime(new Date('2026-08-13T01:30:00Z')) // 22h30 de 12/08 em SP
  expect(nextChargeDay({ anchorDay: 13 })).toBe('2026-08-13')
})
```

## Resultado

A suíte inteira passou a rodar com `TZ=America/Sao_Paulo` de propósito. Todo campo de data novo ganha dois testes de fronteira: um instante entre 21h e 23h59 de Brasília e outro no dia 1º de um mês.

A regra também virou uma lista curta de proibições, cada uma com o sintoma que causa. `toISOString().slice(0, 10)` adianta o dia depois das 21h. `new Date('2026-08-13')` mostra 12/08 numa tela em Brasília. A mesma classe de erro rondava outros pontos, como uma competência digitada no painel que voltaria um dia antes, e a regra única fechou todos de uma vez, em vez de remendar caso a caso.

## O que eu levo disso

Rodar os testes num fuso que exponha o erro, nunca em UTC. E não pedir o fuso do usuário para consertar data civil: numa data civil o fuso é irrelevante, e qualquer conversão reintroduz o erro que a regra existe para impedir.
