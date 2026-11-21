---
title: Separar conta fixa de gasto habitual medindo cobranças por período
summary: "Descobrir assinaturas no extrato parece contar repetições, mas quem mais se repete é o mercado da esquina. Testando a primeira heurística com um histórico realista, troquei a contagem de ocorrências por uma cobrança por período, e o detector passou a separar conta fixa de gasto habitual."
project: yield
order: 2
tags: [TypeScript, Detecção de recorrência, Estatística, Funções puras, Finanças pessoais]
---

O Yield tem um widget de "o que vence nos próximos dias": streaming, academia, conta de luz, plano de celular. A promessa é que o usuário não cadastra nada; o app descobre sozinho a partir do extrato. Quando testei a primeira heurística com um histórico realista, antes de ela ir para a tela, o item com maior confiança era o mercado do bairro. Fazia sentido para o algoritmo: aparecia toda semana, às vezes duas. Para quem lia, era obviamente errado.

## O problema

Encontrar séries recorrentes num histórico de transações e prever a próxima data, com uma nota de confiança. O histórico mistura gasto que parece assinatura (mercado toda semana, posto de gasolina) com assinatura que não parece (a conta de luz muda de valor todo mês e às vezes vence num dia diferente).

## Por que não era trivial

A métrica mais intuitiva engana. Na primeira abordagem, a confiança crescia com o número de ocorrências, e quem mais aparece no extrato é justamente o gasto habitual, não a conta.

O dado bruto também atrapalha. O nome do recebedor às vezes é o intermediário de pagamento (a carteira digital, o adquirente) e não o estabelecimento real, e agrupar por ele junta coisas sem relação. Um Pix para uma empresa e um Pix para uma pessoa são parecidos no extrato. E o dia muda: uma conta do dia 31 cai no dia 28 em fevereiro.

## A solução

O detector é uma função pura: transações entram, séries candidatas saem. Sem banco, sem relógio próprio (a data de referência é parâmetro). Isso me deixou testar dezenas de cenários com dados fabricados e ajustar a heurística sem tocar em infraestrutura.

### Agrupar pelo melhor sinal disponível

Cada transação vai para o grupo do sinal mais confiável que ela tiver: primeiro o estabelecimento já identificado pela classificação, depois o recebedor estruturado do Pix ou do boleto, depois a descrição normalizada (sem marcador de parcela, sem dígitos, sem "LTDA"). Intermediários de pagamento não valem como chave. Dentro de um grupo, um salto grande de valor abre um subgrupo novo, para a assinatura de R$ 29,90 não se misturar com uma compra avulsa de R$ 400 na mesma loja. Uma conta que varia aos poucos continua sendo um grupo só.

### Cadência pela mediana dos intervalos

Calculo os intervalos em dias entre as datas, tiro a mediana e descarto intervalos muito longe dela (mais de 2,5 vezes acima ou abaixo), para uma pausa de um mês não fazer a série parecer irregular. Depois encaixo a mediana no balde mais próximo, cada um com sua tolerância: semanal, quinzenal, mensal, bimestral, trimestral, semestral ou anual. Fora disso, a série é irregular. "Todo dia 5 e 20" é tratado como caso à parte, porque a mediana de 15 dias o confundiria com quinzenal.

### Confiança por "uma cobrança por período"

Essa foi a virada do desenho. Em vez de contar ocorrências, meço quantas cobranças acontecem por ciclo da cadência detectada. Uma conta cobra perto de uma vez por ciclo. O mercado cobra várias. A confiança vira uma soma ponderada: 45% regularidade dos intervalos, 35% proximidade de "uma por período", 10% maturidade da série e 10% estabilidade do valor. Acima de 1,6 cobranças por período, a série é descartada.

Por cima disso entram sinais de domínio. Categorias como energia, telefonia e software somam confiança. Mercado e combustível precisam de uma régua mais alta. Pix para pessoa física perde pontos, porque normalmente é pagamento pontual. Estabelecimentos marcados como tipicamente recorrentes ganham um bônus e são dispensados do critério de valor estável, para a conta de luz variável sobreviver.

### Prever a próxima data e reconciliar

Para ciclos mensais ou maiores, uso o dia do mês mais frequente, ajustado para o último dia quando o mês é curto. Anual soma 12 meses de calendário, não 365 dias. Parcelamento ("PARC 03/12") é série finita e não vira assinatura.

A série é gravada com id próprio, separado do conteúdo, porque a decisão do usuário (confirmar ou dispensar) precisa sobreviver quando a classificação muda. A cada nova classificação, uma reconciliação casa as candidatas com as séries existentes. Uma série silenciosa por cerca de três ciclos é marcada como provavelmente cancelada.

## Um exemplo

Dois grupos fictícios de seis meses, com cadência mensal detectada:

| Grupo | Ocorrências | Cobranças por período | Regularidade | `oncePerPeriod` |
|---|---|---|---|---|
| Streaming, R$ 39,90 todo dia 8 | 6 | 1,0 | alta | 1,0 |
| Mercado do bairro | 31 | ~5,2 | média | 0 |

Com a contagem da primeira abordagem, o mercado ganhava por 31 a 6. Com a nova, ele nem chega à pontuação: 5,2 cobranças por período passa do teto e a série é descartada. O cálculo central, simplificado:

```ts
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

function confidence(s: {
  gapCov: number            // coeficiente de variação dos intervalos
  chargesPerPeriod: number
  maturity: number          // 0 a 1, cresce com o número de ciclos
  amountStability: number   // 0 a 1
}): number | null {
  if (s.chargesPerPeriod > 1.6) return null
  const regularity    = clamp01(1 - s.gapCov / 0.35)
  const oncePerPeriod = clamp01(1 - Math.abs(s.chargesPerPeriod - 1) / 0.6)
  return 0.45 * regularity + 0.35 * oncePerPeriod
       + 0.10 * s.maturity + 0.10 * s.amountStability
}

confidence({ gapCov: 0.04, chargesPerPeriod: 1.0, maturity: 0.8, amountStability: 1 }) // ~0.93
confidence({ gapCov: 0.20, chargesPerPeriod: 5.2, maturity: 1.0, amountStability: 0.3 }) // null
```

O termo `oncePerPeriod` tem pico em 1 e cai dos dois lados. Uma conta que pulou um mês (0,8 por período) perde um pouco; o mercado perde tudo.

## Resultado

O widget lista o que vence, com data prevista e confiança, e deixa de mostrar o que o usuário dispensou. A tela nunca escreve no banco ao ser aberta: toda escrita acontece na reconciliação, que roda no consumidor da fila depois de cada classificação. Como o detector é puro, cada caso novo de extrato vira um teste com meia dúzia de transações fabricadas antes de qualquer ajuste na heurística.

## O que eu levo disso

Antes de escolher uma métrica, pergunto qual comportamento ela premia. Contar ocorrências premiava exatamente o que eu queria descartar. A pergunta certa não era "quantas vezes aparece", e sim "aparece no ritmo de uma conta".
