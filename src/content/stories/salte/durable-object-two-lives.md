---
title: "Deploy de um Durable Object no meio da conversa: a vida antiga precisa se calar"
summary: "Na Cloudflare, a versão antiga de um Durable Object continua viva por um tempo depois do deploy, ao lado da nova. Para o chat com o agente, desenhei um estado de substituição: a vida antiga se retira sozinha, a nova arruma a casa e a tela de quem conversa se recupera sem recarregar."
project: salte
order: 24
tags: [Durable Objects, SSE, Cloudflare Workers, Concorrência, Deploy]
---

Alguém está no meio de uma conversa com o agente bem na hora de um deploy. O ideal é que a pessoa nem perceba: a tela pisca, reconecta e mostra a conversa como ela está. O que não pode acontecer é a mesma resposta aparecer duas vezes, ou um turno ficar marcado como "rodando" para sempre. Garantir isso exigiu lidar com um detalhe da plataforma que quase ninguém nota até desenhar para ele: durante a troca, existem duas instâncias do mesmo objeto.

## O problema

Cada organização tem um Durable Object que coordena o chat com o agente. Um Durable Object, na Cloudflare, é um objeto com identidade única: todas as requisições para aquele id caem na mesma instância, que guarda estado em memória e tem um storage próprio. O coordenador mantém uma fila de pedidos, os turnos em execução e os espectadores conectados por SSE (Server-Sent Events, um stream HTTP de mão única do servidor para o navegador).

Num deploy, o objeto passa a ter duas vidas rodando juntas por um tempo: a antiga, ainda com streams abertos, e a nova, recém-criada. Nos testes de deploy com conversas abertas, isso apareceu de forma concreta: sem um protocolo de troca, as duas podiam escrever na mesma conversa. A troca de versão precisava ser um estado desenhado, não um acaso.

## Por que não era trivial

Quando a Cloudflare troca o código de um Durable Object, a instância antiga não morre na hora. Ela continua viva enquanto alguma requisição ou stream a segura. Do ponto de vista do código antigo, nada mudou: ele tem sua fila em memória, um turno em andamento, espectadores conectados e uma conexão com o banco.

O único sinal de que ele foi substituído é um erro de reset de storage, e esse erro só aparece quando ele tenta usar o storage. Um objeto ocupado em streaming e em chamadas ao banco pode passar um bom tempo sem tocar no storage.

Ao mesmo tempo, a vida nova reconstrói o que precisa a partir do PostgreSQL. Tudo o que a antiga guarda em memória está desatualizado e só atrapalha.

## A solução

### "Vida substituída" como estado

Dei ao objeto um estado explícito de substituído. No primeiro erro de reset do storage, a vida antiga se isola:

1. aborta o turno em execução e os turnos paralelos;
2. esvazia a fila em memória, porque a nova vida a reconstrói do banco;
3. fecha todos os espectadores, e o navegador reconecta na vida nova;
4. para os relógios e temporizadores;
5. fecha a conexão com o banco;
6. e daí em diante recusa qualquer escrita de chat com um erro próprio.

### Não esperar o tropeço

Para não depender de a vida antiga esbarrar no storage por acaso, enquanto há espectadores conectados ela sonda o storage em intervalos curtos. Erro de reset aciona o isolamento. Qualquer outra falha só é registrada, para que um soluço de rede não derrube uma vida saudável.

### O sucessor arruma a casa

A vida nova roda, uma única vez, uma recuperação do que a anterior deixou. Turnos e chamadas marcados como "rodando" são fechados. Escritas que ficaram pela metade viram falha explícita, em vez de sumir. Os pedidos que a vida anterior cortou voltam para a fila. E eles só podem rodar de novo porque a vida anterior está garantidamente calada.

### Deploy verificável

O Worker e o objeto reportam o id da versão em execução. O teste de fumaça do deploy espera até o endpoint de saúde mostrar a versão que a ferramenta de deploy diz ter publicado.

### No navegador

O `EventSource` do navegador só reconecta sozinho em queda de rede. Se o servidor responde com erro, o que acontece durante um deploy, ele desiste. Então o front reconecta por conta própria, com espera crescente. Ele renova a sessão uma vez por queda, não a cada tentativa, porque renovar a cada tentativa criaria um laço de refresh até a API aplicar limite de taxa. E tem um watchdog: o servidor manda pings periódicos, e se o canal fica 50 segundos sem nenhum evento, mesmo sem erro, o front fecha e reabre a conexão. Depois de reabrir, recarrega o estado das conversas, porque eventos podem ter passado enquanto o canal estava mudo.

## Um exemplo

A linha do tempo abaixo é ilustrativa, com tempos aproximados, e mostra um deploy no meio de uma conversa, sem e com o estado de substituição.

Sem o estado de substituição:

| Tempo | Evento |
| --- | --- |
| t=0 | Deploy publicado. Vida A segue com um stream aberto e um turno rodando. |
| t=2s | Nova mensagem chega e cria a vida B, que lê a fila do banco e inicia o mesmo pedido. |
| t=5s | A termina seu turno e grava a resposta. B grava a dela. O chat mostra duas respostas. |
| t=8s | B marca o turno de A como "rodando", porque não sabe que A terminou. Ele fica assim. |

Com o estado de substituição:

| Tempo | Evento |
| --- | --- |
| t=0 | Deploy publicado. Vida A segue com um stream aberto. |
| t=1s | A sonda o storage e recebe erro de reset. Entra no estado substituído. |
| t=1s | A aborta o turno, fecha os streams e para de aceitar escritas. |
| t=1,2s | O navegador recebe erro, espera e reconecta. A conexão cria a vida B. |
| t=1,5s | B roda a recuperação: fecha o turno pendente e devolve o pedido à fila. |
| t=2s | B executa o pedido uma vez. O navegador recarrega o chat e mostra o estado certo. |

O núcleo do isolamento é pequeno. Em versão simplificada:

```ts
async function guard<T>(write: () => Promise<T>): Promise<T> {
  if (this.superseded) throw new ObjectReplacedError();
  try {
    return await write();
  } catch (error) {
    if (isStorageReset(error)) {
      // esta vida não sabe mais o que é verdade; o sucessor reconstrói do banco
      this.supersede();
      throw new ObjectReplacedError();
    }
    throw error;
  }
}
```

Toda escrita de chat passa por esse guarda. A vida antiga pode até receber uma requisição atrasada, mas não grava mais nada.

## Resultado

Duas vidas não escrevem mais na mesma conversa. Quem está com a tela aberta durante um deploy vê a reconexão acontecer sozinha e encontra o estado correto. Cobri o isolamento com um teste de unidade que simula o reset do storage, e o teste de fumaça confirma que a versão nova está de fato no ar antes de considerar o deploy concluído.

## O que eu levo disso

Em sistemas com objetos de vida longa, a substituição precisa ser um estado projetado, não um acidente. Quem sabe que foi substituído se cala. O sucessor reconstrói a partir de uma fonte de verdade que não é a memória de ninguém. E do lado do cliente, um stream silencioso deve ser tratado como um stream quebrado.
