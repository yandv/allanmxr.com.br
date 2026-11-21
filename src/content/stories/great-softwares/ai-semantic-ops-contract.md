---
title: "Edição com IA por operações: o modelo diz o que mudar, não reescreve"
summary: "Pedir ao modelo um elemento inteiro de volta deixa a IA inventar cores, apagar atributos e cobrar por edições que não mudam nada. Desenhei a edição para o modelo só dizer o que mudar, usando as cores da marca, e o servidor recusar sem cobrar o pedido que deixa tudo igual."
project: great-softwares
order: 3
tags: [LLM, Edição com IA, Contratos de API, Cobrança por uso, Zod]
---

A pessoa seleciona um botão no editor do Great Pages e digita "deixa essa borda arredondada e usa a cor principal da marca". Do outro lado, um modelo de linguagem recebe o pedido. O jeito mais curto de implementar isso é mandar o HTML do elemento e pedir um elemento novo de volta. Funciona na demo e falha no uso real: o modelo inventa um hexadecimal parecido com a cor da marca, apaga um atributo que não entendeu e, quando o botão já estava arredondado, cobra créditos por uma edição que não mudou nada.

## O problema

Eu queria três coisas ao mesmo tempo. Que o modelo dissesse apenas o que mudar, em termos que o produto entende. Que as cores e os tamanhos viessem do design system da página, e não de um palpite. E que a pessoa não pagasse por um pedido que deixa o elemento igual.

## Por que não era trivial

- **A saída do modelo é entrada não confiável.** O nome de uma operação vem do modelo. Se eu valido com `catalog[name]` num objeto comum, um nome como `toString` encontra a função herdada de `Object.prototype` e passa como se existisse.
- **Editor e backend têm deploys separados** e compartilham o catálogo de operações por cópia de arquivo. Se um lado sobe com uma versão nova e o outro não, o protocolo diverge em silêncio.
- **Cobrar com justiça exige saber o estado atual do elemento**, e decidir isso no lugar errado abre espaço para cobrar uma edição inútil ou deixar de cobrar uma real.
- **O custo de uma chamada varia com os tokens**, mas a pessoa vê um preço em créditos e espera previsibilidade.

## A solução

### Um catálogo fechado de operações

O modelo deixou de emitir elementos e passou a emitir operações de um catálogo com algumas dezenas de itens: cor de fundo por slot do guia de estilos, preset de borda, sombra, tamanho, posição, criar elemento e assim por diante. Cada operação declara em quais tipos de elemento vale, o escopo e os argumentos, validados por schema.

O prompt descreve o elemento no vocabulário das operações, nunca no DOM cru. O guia de estilos entra com uma regra explícita: se a cor pedida não existe na marca, a operação é recusada com um erro de slot desconhecido, em vez de inventar um valor. Quando o orçamento de caracteres do prompt aperta, o guia perde linhas de cor e o texto avisa quantas foram omitidas. Cortar calado faria o modelo concluir que a cor "não existe".

O catálogo é montado com `Object.create(null)`, um objeto sem protótipo. Um nome que não está lá é sempre recusado.

### Hash de contrato entre os dois repositórios

Os dois lados calculam um hash FNV-1a (um hash não criptográfico, rápido e determinístico) sobre a superfície do contrato: versão e, por operação, tipos aceitos, escopo e argumentos. Descrições e textos de ajuda ficam fora de propósito. Se o texto entrasse no hash, corrigir uma vírgula numa descrição derrubaria o protocolo até os dois deploys saírem juntos.

O editor manda o hash em cada pedido. Se não bate, o serviço volta ao caminho antigo de edição, em vez de aplicar operações que o outro lado talvez não reconheça.

### Um simulador antes de cobrar

Para cada operação existe um leitor que olha o estado atual do elemento no servidor e devolve um de três veredictos: muda, já está satisfeita (inerte) ou ilegível. Se o lote inteiro é inerte, a resposta é "o elemento já está assim" e nada é cobrado.

A regra que guia todos os leitores é assimétrica: o único erro caro é dizer "inerte" sobre algo que mudaria, porque aí a pessoa pede uma coisa e nada acontece. Por isso qualquer dúvida cai em ilegível, que segue e cobra.

### Preço previsível

O custo de uma edição passou a vir dos tokens consumidos, arredondado para cima ao múltiplo de 5 créditos. A pessoa vê números redondos e o preço acompanha o trabalho real.

## Um exemplo

O botão já tem borda arredondada pelo preset `rounded-lg` do guia. A pessoa pede "arredonda a borda". O modelo responde com uma operação:

```ts
type Verdict = { kind: 'changes' } | { kind: 'inert'; reason: string } | { kind: 'unreadable' };

type Op = { op: 'set_border_preset'; preset: string } | { op: 'set_border_radius_px'; px: number };

function simulate(op: Op, el: { borderPreset: string | null; radiusPx: number | null }): Verdict {
  if (op.op === 'set_border_preset') {
    if (el.borderPreset === op.preset) return { kind: 'inert', reason: `o preset "${op.preset}" já está aplicado` };
    return { kind: 'changes' };
  }
  // Um px literal por cima de um preset desvincula o elemento do guia: isso é mudança real.
  if (el.borderPreset !== null) return { kind: 'changes' };
  if (el.radiusPx === null) return { kind: 'unreadable' };
  return el.radiusPx === op.px ? { kind: 'inert', reason: 'o raio já é esse' } : { kind: 'changes' };
}
```

Com `{ op: 'set_border_preset', preset: 'rounded-lg' }`, o veredito é inerte e o pedido volta como "o elemento já está assim", sem débito. Com `{ op: 'set_border_radius_px', px: 12 }`, o veredito é muda, mesmo que visualmente o resultado seja parecido: trocar o preset por um valor fixo faz o botão parar de acompanhar o tema quando a marca mudar.

Um detalhe da implementação mostra o tipo de cuidado que o leitor exige. Para ler os ajustes de uma imagem, o leitor remove `drop-shadow(...)` do filtro. Uma expressão regular que pare no primeiro `)` erra quando esse parêntese é o fechamento de um `rgba(...)` interno: sobra um parêntese, a leitura falha e o veredito vira ilegível em vez de inerte. Por isso a remoção é uma varredura que conta a profundidade dos parênteses, e não uma regex.

## Resultado

A IA passou a mudar o que a pessoa pediu usando os valores do design system da página, e um pedido que não muda nada é recusado antes da cobrança. Quando editor e backend divergem no catálogo, o sistema cai num caminho conhecido em vez de aplicar meia edição. E o prompt também ficou mais útil em pedidos mistos: a parte possível é aplicada e o resto é explicado, em vez de recusar tudo.

## O que eu levo disso

Quando dois repositórios compartilham um contrato por cópia, coloque um hash no contrato, mas só sobre o que muda comportamento. Em qualquer coisa que envolva cobrança, escolha de antemão para que lado a dúvida cai, e escreva isso no código. Prefiro cobrar uma edição duvidosa e melhorar o leitor depois a negar uma edição real.
