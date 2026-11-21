---
title: "Trocar de cartão depois de uma recusa sem recarregar o checkout"
summary: "Depois de uma recusa, o comprador precisa poder tentar outro cartão sem receber de volta a recusa gravada nem arriscar cobrança dupla num retry de rede. Recortei a chave de idempotência por tentativa no SDK de checkout, e a nova tentativa funciona sem recarregar a página."
project: araute
order: 12
tags: [SDK, TypeScript, Idempotência, 3DS, Checkout]
---

Imagine um comprador que digita o cartão no checkout de uma loja, clica em pagar e o banco recusa: saldo insuficiente. Ele pega outro cartão na carteira, digita de novo e clica outra vez. Se a tela mostrar "pagamento recusado" de novo, instantaneamente, sem nem consultar o banco, o segundo cartão nunca foi tentado e o lojista perdeu a venda. Esse cenário apareceu cedo, no modo de teste do SDK, e a causa está em onde se desenha a fronteira da chave de idempotência.

## O problema

O checkout transparente da Araute deixa o lojista receber cartão na própria página, sem redirecionar o comprador. O número do cartão (o PAN, na sigla do setor) não pode passar pelo servidor do lojista nem pelo da Araute, porque isso traria toda a carga de conformidade de quem armazena cartão. Ele é digitado num formulário seguro, dentro de um iframe do adquirente, e o lojista monta esse formulário com o [`@araute/js`](https://docs.araute.com/guias/checkout-transparente), um SDK de navegador público e sem dependências em tempo de execução.

O formulário precisava sobreviver ao uso real: cartão recusado, desafio 3DS (a etapa em que o banco emissor pede confirmação ao comprador, por app ou código) abrindo e fechando, aba esquecida em segundo plano. E o lojista não deveria escrever nenhum tratamento especial para isso.

## Por que não era trivial

Cada tentativa de pagamento cobra dinheiro, então ela precisa de uma chave de idempotência. A regra do header `Idempotency-Key` é clara: mesma chave, mesma resposta. Isso cria duas armadilhas opostas.

Se a segunda tentativa reaproveita a chave da primeira, a API devolve a resposta gravada da primeira, que foi uma recusa. É o comprador da abertura.

Se cada chamada gera uma chave nova, um retry de rede (a requisição saiu, a resposta se perdeu, o navegador tenta de novo) vira uma segunda cobrança.

Somava-se a isso a validade curta do formulário do adquirente, de 15 minutos. Renovar com a aba oculta gasta renovação à toa. Renovar no meio de um desafio 3DS destrói o desafio.

## A solução

### O modelo do client_secret

O backend do lojista cria o pagamento com a chave secreta e entrega ao navegador só um `client_secret`, que serve para montar e confirmar aquele pagamento e nada mais. Ele viaja sempre no header `Authorization`, nunca na URL, para não acabar em `Referer`, log de servidor ou histórico do navegador. A confirmação parte do navegador do comprador para que a análise antifraude receba o IP real dele.

### Recortar a chave pela intenção de cobrar

A pergunta certa não é "qual é o pagamento?", e sim "qual é a tentativa?". O cliente HTTP do SDK guarda chaves por escopo. A primeira confirmação usa uma chave estável para aquele escopo, então um retry de rede reaproveita a mesma chave e recebe a mesma resposta. Uma nova tentativa, depois de uma anterior já finalizada, ganha uma chave própria. Dentro de uma tentativa, retry é replay. Entre tentativas, cada uma é uma operação nova.

### Renovar sem atrapalhar

O SDK agenda a renovação do formulário um pouco antes de ele vencer. Se a aba está oculta, adia até ela voltar a ficar visível. Enquanto o comprador está num desafio 3DS, o timer é cancelado e só volta quando o desafio termina. Se o envio pega um formulário já vencido, o SDK renova na hora. Em todos os casos, o que o comprador já digitou é preservado.

### Recusa não encerra o formulário

Só um pagamento aprovado interrompe a renovação. Um cartão recusado deixa o formulário aberto para outra tentativa, sem recarregar a página.

### Um submit que nunca fica pendurado

Quem usa o próprio botão de pagar chama `submit()`, que resolve quando a tentativa termina: com o resultado, com um erro de validação do formulário ou quando o comprador entra no desafio 3DS. O lojista nunca fica com um botão eternamente em "processando".

### O navegador não confirma pagamento

O resultado que chega ao navegador, no callback `onResult`, serve para trocar a tela. Quem libera o pedido é o webhook ou uma consulta ao pagamento pelo backend, porque o navegador é controlado por quem está do outro lado. A documentação diz isso em destaque.

## Um exemplo

A sessão do comprador da abertura, agora com o recorte certo:

```txt
t=0s     confirm (cartão A)        Idempotency-Key: k1  -> enviado
t=8s     rede cai antes da resposta; SDK repete
t=9s     confirm (cartão A)        Idempotency-Key: k1  -> replay: "recusado"
t=40s    comprador troca o cartão
t=41s    confirm (cartão B)        Idempotency-Key: k2  -> desafio 3DS aberto
t=41s    timer de renovação suspenso
t=75s    desafio concluído          -> "aprovado"; renovação encerrada
```

O retry do segundo 9 não gerou uma segunda tentativa com o cartão A. A troca para o cartão B não recebeu a recusa antiga. Do lado do SDK, a ideia cabe em poucas linhas:

```ts
class ApiClient {
  private keys = new Map<string, string>()

  private keyFor(scope: string | null): string {
    // sem escopo: operação nova, chave nova
    if (scope === null) return crypto.randomUUID()
    // com escopo: retry da mesma operação reaproveita a chave
    let key = this.keys.get(scope)
    if (!key) {
      key = crypto.randomUUID()
      this.keys.set(scope, key)
    }
    return key
  }

  confirm(type: 'card') {
    return this.post('/confirm', { type }, this.keyFor(`confirm:${type}`))
  }

  confirmRetryAfterDecline() {
    return this.post('/confirm', {}, this.keyFor(null))
  }
}
```

Para o lojista, nada disso aparece. A integração continua sendo montar o campo e reagir ao resultado:

```ts
const araute = Araute(clientSecret)
await araute.mountCard('#card', {
  onResult: (result) => showThanks(result.paid),
  onError: (error) => showRetry(error.code),
})
```

## Resultado

O comprador consegue tentar de novo depois de uma recusa sem recarregar a página, e um retry de rede nunca vira segunda cobrança. O SDK sai com build ESM e bundle global, e com uma tabela pública de códigos de erro estáveis, separando os que acontecem antes de o formulário aparecer dos que chegam depois, durante a renovação.

Com uma chave de teste, o SDK monta no lugar do formulário do adquirente um formulário de teste da Araute, com cartões que aprovam e recusam. Foi exatamente esse modo que deixou o problema da chave visível cedo: recusar e tentar de novo passou a ser um cenário trivial de reproduzir.

## O que eu levo disso

Idempotência protege uma intenção, e a fronteira da intenção precisa ser escolhida com cuidado. Aqui, a intenção não era "pagar este pedido", era "cobrar este cartão agora". Uma chave por tentativa, e cada nova tentativa ganha a sua.
