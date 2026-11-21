---
title: Um cofre de senhas que nem o meu servidor consegue abrir
summary: "O agente precisava digitar senhas de sistemas externos, e guardá-las com uma chave nossa exporia todas numa invasão. Fiz um cofre que nem o meu servidor abre, destravado por passkey quando uma pessoa autorizada aprova."
project: salte
order: 23
tags: [HPKE, WebAuthn, Passkeys, X25519, Durable Objects, Criptografia]
---

Um agente da Salte opera um navegador remoto em nome da equipe de uma clínica, para tarefas repetitivas em sistemas externos. Em algum momento a tarefa chega a uma tela de login. O agente precisa digitar usuário e senha. A pergunta que me tirou o sono foi: onde essa senha estava um segundo antes? Se a resposta fosse "no nosso banco, cifrada com uma chave nossa", então qualquer pessoa com acesso ao banco e à chave abriria todas as senhas de todos os clientes.

## O problema

Cifrar com uma chave da plataforma protege contra quem só vê o banco, mas não contra quem tem acesso aos dois. Eu queria um cofre em que o servidor guardasse apenas envelopes que ele não sabe abrir. E queria que o agente só digitasse uma senha quando uma pessoa autorizada estivesse presente, aprovando aquele uso específico.

## Por que não era trivial

O agente precisa da senha em texto puro para digitar no campo. E quem executa o agente é o servidor. Então alguém tem que entregar a senha ao servidor no momento do uso, sem que ela passe por nenhum lugar persistente, e sem que um pedido capturado possa ser reaproveitado depois.

Havia ainda os problemas de gente. Uma organização tem mais de um responsável. Quando um deles sai, a chave precisa girar. E passkeys se perdem junto com o celular.

## A solução

### Selar no navegador

Quem cadastra o login digita a senha no próprio navegador. Ali mesmo, o conteúdo (origem do sistema, domínios permitidos, usuário, senha) é selado com a chave pública do cofre usando HPKE (Hybrid Public Key Encryption, RFC 9180: um padrão para cifrar uma mensagem para uma chave pública). A suíte é X25519 para a troca de chaves, HKDF-SHA256 para derivação e AES-256-GCM para cifrar.

O servidor recebe só o envelope e metadados. A API rejeita qualquer corpo que traga um campo de senha em texto puro, sem ecoar o valor no erro. Nenhuma chave da plataforma abre o envelope.

### Quem guarda a chave do cofre

A chave privada do cofre é selada separadamente para cada guardião, uma pessoa responsável marcada na organização, e só abre com a passkey dele, exigindo verificação de usuário (biometria ou PIN). Isso usa a extensão PRF do WebAuthn, que deixa a passkey derivar um segredo estável sem expor a chave dela. Para quem não tem passkey com PRF, existe uma frase de recuperação com uma função de derivação cujo custo mínimo o próprio banco impõe.

### Destravar com a pessoa presente

Quando o agente chega a um login selado, um guardião precisa aprovar o destravamento. O pedido nasce dentro de um Durable Object (um objeto da Cloudflare com estado em memória e uma única instância por chave, o que dá um ponto natural de coordenação). Ali é gerado um par de chaves X25519 efêmero e não extraível, que nunca vai para armazenamento.

O pedido tem um identificador de uso único, vale por 120 segundos, e carrega um desafio que amarra organização, sistema, pedido e a chave pública efêmera. O navegador do guardião assina esse desafio com a passkey, abre o envelope localmente, mostra "o agente vai entrar em tal sistema como tal usuário" e sela de novo, agora para a chave efêmera.

### Recusar tudo que não for exatamente aquilo

O servidor confere a asserção da passkey antes de qualquer coisa chegar ao objeto: a passkey pertence ao guardião, a origem e o identificador do site batem exatamente, o contador de uso subiu. O objeto recusa pedido inexistente, vencido, já usado ou com desafio de outro pedido. Se dois guardiões respondem ao mesmo tempo, o primeiro ganha e só um login é digitado. Se a origem guardada no envelope não bate com o site do login, a operação para.

A senha abre na memória, vai para a digitação e sai da memória logo depois.

### Saída e perda

Remover um guardião apaga os envelopes dele e marca o cofre para girar a chave. Revogar uma passkey por suspeita de perda tira o guardião do cofre, mesmo que seja a única, porque quem tem o aparelho consegue abrir o que ela protege.

## Um exemplo

Uma linha do tempo de um destravamento, com tempos ilustrativos:

| Tempo | O que acontece |
| --- | --- |
| t=0 s | O agente chega ao login de um sistema com senha selada e pausa. |
| t=0,1 s | O Durable Object gera o par efêmero, o id de uso único e o desafio. Prazo: t=120 s. |
| t=8 s | O guardião abre o pedido no navegador e confirma com biometria. A passkey assina o desafio. |
| t=8,3 s | O navegador abre o envelope localmente e sela de novo para a chave efêmera. |
| t=8,5 s | O servidor valida a asserção. O objeto confere id, prazo e desafio e marca o pedido como usado. |
| t=8,6 s | A senha é aberta em memória, digitada no campo e descartada. A chave efêmera morre com o pedido. |
| t=9 s | Um segundo guardião responde ao mesmo pedido e recebe recusa: já usado. |

A peça central do lado do servidor cabe em poucas linhas:

```ts
const pending = new Map<string, { keyPair: CryptoKeyPair; challenge: string; expiresAt: number }>();

async function openUnlockRequest(context: string) {
  // extractable = false: a chave privada nunca sai do objeto nem vai para disco
  const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
  const requestId = crypto.randomUUID();
  const challenge = await sha256(`${context}|${requestId}`);
  pending.set(requestId, { keyPair, challenge, expiresAt: Date.now() + 120_000 });
  return { requestId, challenge };
}

function claim(requestId: string, challenge: string) {
  const request = pending.get(requestId);
  pending.delete(requestId); // uso único, mesmo quando a verificação falha
  if (!request || request.challenge !== challenge || Date.now() > request.expiresAt) return null;
  return request.keyPair;
}
```

O `delete` antes da verificação é proposital: um pedido nunca tem segunda chance, mesmo que a primeira tentativa venha errada.

## Resultado

O servidor guarda apenas o que não consegue abrir. Um vazamento do banco entrega envelopes sem chave. Cada destravamento virou um evento com pessoa, passkey, prazo e uma chave que deixa de existir quando o pedido termina. E a pergunta "onde a senha estava um segundo antes?" ganhou uma resposta boa: no navegador de alguém autorizado, que acabou de dizer sim.

## O que eu levo disso

Quando o servidor precisa de um segredo por alguns segundos, faça o segredo chegar por um canal efêmero, amarrado ao pedido e protegido por uma chave não extraível. Uma chave guardada é uma chave que um dia vai estar no lugar errado.
