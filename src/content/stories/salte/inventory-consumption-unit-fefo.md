---
title: "Estoque de clínica: frasco na compra, mililitro na aplicação e lote que vence primeiro"
summary: "Uma clínica compra medicamento em frasco e aplica em mililitro ou miligrama, e precisa gastar primeiro o lote que vence antes. Desenhei o estoque com duas unidades sobre um inteiro só, baixa por vencimento ao finalizar a sessão e uma sugestão de baixa tirada da receita da consulta."
project: salte
order: 6
tags: [Estoque, FEFO, PostgreSQL, ERP, TypeScript]
---

Uma enfermeira aplica 0,5 mL de um medicamento que a clínica compra em frascos de 2,4 mL. No fim do atendimento, o estoque precisa dizer quanto sobrou: não "um frasco a menos", mas "um frasco aberto com 1,9 mL". Na prateleira há dois lotes do mesmo medicamento, um vencendo em três semanas e outro em seis meses. O que vence antes tem de sair primeiro, e o que está separado para a sessão de outro paciente não pode ser tocado.

## O problema

Estoque de clínica não é estoque de loja. A unidade de compra (caixa, frasco, ampola) é diferente da unidade de consumo (mL, mg, comprimido), e a aplicação quase nunca usa uma unidade de compra inteira. Medicamento tem lote e validade, e desperdiçar por vencimento custa caro. E a baixa precisa acontecer no ponto em que o consumo é registrado clinicamente, ao finalizar o atendimento, sem depender de alguém lembrar de lançar depois.

## Por que não era trivial

Guardar quantidade fracionada em ponto flutuante é pedir erro de arredondamento: 0,1 mais 0,2 não dá 0,3, e um frasco que rende 4,8 doses vira 4,76 depois de algumas contas. Mudar o tipo das colunas de quantidade também mexeria em todo o estoque existente.

A baixa ao finalizar a sessão roda dentro da transação clínica, com vários itens ao mesmo tempo. Duas sessões finalizando juntas podem disputar os mesmos itens em ordens diferentes e travar uma à outra.

E reservas, baixas e estornos precisam conviver: o que está reservado não está disponível, o que foi consumido numa sessão não pode ser "desconsumido" por engano, e o que foi estornado precisa voltar ao lote de onde saiu.

## A solução

### Duas unidades sobre um inteiro

As quantidades continuam inteiras, contando passos de saldo. Cada item tem um fator de conversão: 1 para item comum; para item com unidade de consumo, a unidade de compra medida em centésimos da unidade de consumo. Um frasco de 2,4 mL tem fator 240. Nenhuma coluna mudou de tipo.

Na API, a quantidade é sempre em unidades de compra, e a fração vem num campo separado, em centésimos da unidade de consumo. Os dois se somam: "3 frascos e 0,5 mL" é 3 × 240 + 50 = 770 passos. Uma dose de 0,5 mL é exatamente 50 passos, então um frasco rende 4,8 doses, nunca 4,76. A tela mostra "3 frascos (7,20 mL)".

### Baixa por vencimento, sem tocar no reservado

A baixa segue FEFO (first expired, first out: sai primeiro o que vence primeiro). Primeiro o saldo sem lote, depois os lotes por validade mais próxima, com os sem validade por último. De cada lote só sai o que está em mão menos o que está reservado. Se a enfermeira escolheu um lote específico, a escolha dela vale e o FEFO é pulado. Usar um lote vencido gera aviso, não recusa, e a janela de aviso de vencimento é configurável por clínica.

### Consumo dentro da finalização

Ao finalizar a sessão, o consumo é registrado na mesma transação do registro clínico, por um único serviço dono do saldo. Os itens são travados numa ordem estável, sempre a mesma, para duas finalizações simultâneas nunca se travarem mutuamente. Item que é só de catálogo, sem controle de saldo, é pulado. Falta de saldo é um conflito que diz qual item faltou.

### Reserva, baixa e estorno

Uma reserva segura unidades de um único lote, o primeiro na ordem FEFO que cobre a quantidade inteira. Se nenhum lote cobre sozinho, a reserva é recusada e a mensagem mostra quanto cada lote pode dar. Cancelar uma reserva não gera movimento, porque nada saiu da prateleira.

O estorno é um movimento novo, com o sinal oposto, que volta exatamente aos lotes de onde saiu, uma vez só por movimento. Consumo de sessão não é estornável: o atendimento finalizado continuaria dizendo que o insumo foi usado.

### Sugestão de baixa pela receita

Para a enfermeira não montar a baixa de memória, a consulta oferece sugestões: uma linha por item, com os medicamentos da receita emitida no atendimento primeiro e os itens citados na transcrição da consulta depois. Cada linha traz o saldo, o próximo lote FEFO, a quantidade que a dose prescrita representa e se há falta. A quantidade vem sempre da receita, nunca da fala. A transcrição só sinaliza itens mencionados, com tolerância a erro de digitação proporcional ao tamanho da palavra, e não é guardada nem registrada em log. Dose por superfície corporal, como "85 mg/m²", não vira quantidade: a sugestão deixa em aberto em vez de chutar.

## Um exemplo

Três itens fictícios, com a conta da sugestão:

| Item | Compra | Fator | Prescrito | Sugestão |
| --- | --- | --- | --- | --- |
| Ondansetrona | ampola de 2 mg | 1 | 8 mg | 4 ampolas |
| Medicamento X | frasco de 100 mg | 10.000 | 250 mg | 2 frascos e 50 mg |
| Medicamento Y | frasco de 2,4 mL | 240 | 0,5 mL | 50 passos; o frasco fica com 190 |

```ts
type Item = { mgPerPurchaseUnit: number; conversionFactor: number; hasConsumptionUnit: boolean };

function suggestedUsage(item: Item, doseMg: number) {
  if (!item.hasConsumptionUnit) {
    // unidade inteira: arredonda para cima, nunca sugere menos do que a dose pede
    return { purchase: Math.max(1, Math.ceil(doseMg / item.mgPerPurchaseUnit - 1e-9)), steps: null };
  }
  return { purchase: null, steps: Math.max(1, Math.round((doseMg / item.mgPerPurchaseUnit) * item.conversionFactor)) };
}

suggestedUsage({ mgPerPurchaseUnit: 2, conversionFactor: 1, hasConsumptionUnit: false }, 8); // 4 ampolas
suggestedUsage({ mgPerPurchaseUnit: 100, conversionFactor: 10_000, hasConsumptionUnit: true }, 250); // 25.000 passos
```

Com dois lotes do Medicamento Y, um vencendo em três semanas com 2 frascos, 1 deles reservado, e outro em seis meses, a baixa de 50 passos sai do lote que vence antes, da parte não reservada.

## Resultado

O estoque fala a língua da clínica: compra em frasco, aplica em mililitro e mostra os dois. As contas fracionadas são exatas porque nunca saem dos inteiros. A baixa acontece na finalização do atendimento, pelo lote que vence primeiro, sem tocar no que está reservado e sem travar outra finalização. E a sugestão tirada da receita evita que a enfermeira calcule dose em quantidade de cabeça.

## O que eu levo disso

Quando duas unidades convivem, escolha a menor como verdade e guarde inteiros. Ordem estável de lock é a forma mais barata de evitar deadlock. E numa sugestão automática, separe o que é fonte confiável, a receita, do que é só pista, a fala, e nunca deixe a pista decidir o número.
