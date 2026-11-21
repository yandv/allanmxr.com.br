---
title: Saque de afiliado por Pix sem chave ambígua e sem estourar o teto mensal
summary: "Uma chave Pix digitada errado só seria descoberta dias depois, no pagamento, com o saldo já descontado. Desenhei o saque para validar os dados no cadastro e para que dois cliques simultâneos nunca passem do teto mensal."
project: great-softwares
order: 21
tags: [Pix, Validação de dados, Concorrência, Afiliados, Dinheiro em centavos]
---

Imagine um afiliado do Great Apps que acumula comissão, abre a tela de saque, pede R$ 200 e recebe a confirmação. Dias depois a operação tenta pagar o Pix e a instituição recusa: a chave cadastrada era um número de 11 dígitos tratado como CPF, mas era o celular dele sem o `+55`. O saldo já saiu da conta do afiliado, o dinheiro não chegou em lugar nenhum, e o caso vira atendimento manual. É um erro pequeno, e evitá-lo dependia de uma decisão de desenho: validar o dado quando ele entra, não quando o dinheiro sai.

## O problema

O programa de afiliados transforma comissão em saldo, e o afiliado pede saque desse saldo por Pix. O fluxo junta dinheiro com dados bancários digitados à mão: documento do titular (CPF ou CNPJ) e chave Pix.

As regras dependem desses dados. Pessoa física tem um teto mensal de saque de R$ 350. Pessoa jurídica não tem teto, mas precisa anexar a nota fiscal em PDF. O código decidia entre PF e PJ olhando o tamanho do documento. Um documento com dígitos errados, ou com tamanho estranho, virava a regra errada.

## Por que não era trivial

**Chave Pix de 11 dígitos é ambígua.** Pode ser um CPF ou um celular sem código do país. Muitos números de celular também passam no dígito verificador de CPF. Adivinhar errado manda o Pix para outra pessoa ou para lugar nenhum.

**Dado legado não pode travar quem já usa.** Havia afiliados antigos com documento mal formatado. Se a nova validação recusasse qualquer edição do cadastro, um afiliado que só quisesse trocar o nome do titular ficaria preso.

**O teto mensal é uma regra de agregado.** "A soma dos saques do mês não passa de R$ 350" depende de todos os outros saques. Dois pedidos simultâneos, cada um lendo o total antes do outro gravar, passam juntos e estouram o teto.

**Dinheiro em ponto flutuante mente.** Comparar `99.995` com outro valor arredondado via `toFixed` dá resultados diferentes conforme o caminho do cálculo.

## A solução

### Validar quando o dado entra

A rota de atualização do afiliado repassava o corpo quase direto para o banco. Coloquei a validação nos pontos de escrita, com semântica de atualização parcial: o documento só é validado quando vem no payload. Quem edita só o nome não é bloqueado pelo dado antigo.

Um módulo de validação classifica o documento (CPF ou CNPJ, com dígito verificador) e a chave Pix (CPF, CNPJ, celular, e-mail ou chave aleatória). Duas recusas novas cobrem os casos mais arriscados:

- **chave ambígua**: o número de 11 dígitos passa como CPF e também tem forma de celular. A mensagem explica o que fazer: se for celular, informe com `+55`; se for CPF, ele precisa ser o do titular;
- **chave que é documento de outra pessoa**: CPF ou CNPJ válido, mas diferente do documento do titular cadastrado.

Na gravação, a chave é normalizada: só dígitos para CPF e CNPJ, `+55` explícito para celular. Assim a operação nunca recebe um formato que precise interpretar.

### Pedido de saque em centavos

Todo valor vira inteiro em centavos antes de qualquer comparação. O mínimo de saque é 2500 centavos, o teto mensal de PF é 35000. A decisão entre PF e PJ passa a usar o documento validado e a classificação da chave, não o comprimento de uma string.

### Saldo e teto protegidos contra concorrência

O desconto do saldo é um decremento atômico no banco, e não "ler, subtrair, gravar". Só depois disso a transação de saque é criada como pendente.

Para o teto mensal, usei uma checagem otimista em duas etapas. Antes de gravar, somo os saques do mês (sem contar os cancelados e recusados) e recuso se o novo pedido passar do teto. Depois de gravar, somo de novo. Se o total agora passa do teto, outro pedido simultâneo entrou junto: devolvo o saldo, cancelo a transação que acabei de criar e respondo com o valor que ainda está disponível. Para PJ, se o upload da nota fiscal falhar, a mesma reversão acontece, para nunca existir saque de empresa sem nota.

### Comissão que converge

A comissão nasce de faturas da Stripe, e o valor pode mudar por cupom entre a emissão e o pagamento. Um recálculo roda perto do vencimento e aplica a mesma regra de cupom usada no resto da cobrança. Faturas sem nada pendente são puladas, então o processo converge em vez de refazer trabalho. Uma tarefa periódica consolida no saldo as comissões pendentes com mais de um mês, em lotes.

## Um exemplo

Um afiliado PF já sacou R$ 200 este mês. Ele clica duas vezes no botão de saque de R$ 100, e as duas requisições chegam juntas. Valores fictícios:

| Tempo | Requisição A | Requisição B | Total do mês |
| --- | --- | --- | --- |
| t=0 | soma do mês: 20000 | | 20000 |
| t=5ms | | soma do mês: 20000 | 20000 |
| t=10ms | 20000 + 10000 ≤ 35000, grava | | 30000 |
| t=14ms | | 20000 + 10000 ≤ 35000, grava | 40000 |
| t=20ms | recontagem: 40000 > 35000, reverte | | 30000 |
| t=22ms | | recontagem: 30000 ≤ 35000, segue | 30000 |

Nesse cenário a requisição A recontou primeiro, viu os dois saques gravados e reverteu o próprio. B recontou depois da reversão e seguiu. Na pior intercalação as duas revertem e o afiliado tenta de novo: o sistema erra para o lado seguro, nunca para o lado de pagar acima do teto.

```ts
async function requestWithdrawal(affiliate: Affiliate, amountCents: number) {
  if (amountCents < 2500) return refuse("Valor mínimo de saque é R$ 25,00.");
  if (affiliate.balanceCents < amountCents) return refuse("Saldo insuficiente.");

  const isCompany = isCnpj(affiliate.pixKey) || isCnpj(affiliate.holderDocument);
  if (!isCompany && (await monthlyTotal(affiliate.id)) + amountCents > 35000) {
    return refuse("Limite mensal de saque para CPF atingido.");
  }

  await db.decrement("affiliates", affiliate.id, "balance_cents", amountCents);
  const withdrawal = await db.insert("withdrawals", { affiliateId: affiliate.id, amountCents, status: "pending" });

  // A primeira checagem não enxerga pedidos simultâneos; a recontagem
  // depois de gravar enxerga, e desfaz o próprio pedido se estourou.
  if (!isCompany && (await monthlyTotal(affiliate.id)) > 35000) {
    await db.increment("affiliates", affiliate.id, "balance_cents", amountCents);
    await db.update("withdrawals", withdrawal.id, { status: "canceled" });
    return refuse("Limite mensal de saque para CPF atingido.");
  }
  return withdrawal;
}
```

## Resultado

O afiliado só consegue cadastrar uma chave que o Pix tem chance real de aceitar, e quando o número é ambíguo ele é orientado na hora, não dias depois. A regra de PF e PJ vale pelo documento validado. Dois cliques no botão não estouram o teto, e nenhum saque de empresa fica sem nota fiscal.

## O que eu levo disso

Valide o dado no momento em que ele entra, não quando o dinheiro vai sair: na entrada, o erro custa uma mensagem; na saída, custa um atendimento. Guarde e compare dinheiro em inteiros. E quando uma regra depende de um agregado, como um teto mensal, conte de novo depois de gravar. É a forma mais barata de fechar a corrida sem lock distribuído.
