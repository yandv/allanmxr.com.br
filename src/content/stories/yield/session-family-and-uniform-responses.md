---
title: Quando o cookie de refresh é reusado, eu derrubo o dispositivo inteiro
summary: "Com um refresh token comum, um cookie roubado vale por semanas, e telas de login e senha costumam revelar quem tem conta. Desenhei a autenticação para o reuso de um cookie derrubar o dispositivo inteiro e as respostas saírem iguais com ou sem conta."
project: yield
order: 3
tags: [Refresh token, Autenticação, Enumeração de usuários, Segurança, bcrypt]
---

Imagine que alguém copia o cookie de refresh de um usuário do Yield, seja por uma extensão maliciosa no navegador, seja por um computador compartilhado. Com um refresh token comum, essa pessoa ganha uma sessão que se renova sozinha por semanas. Em outra frente, alguém digita e-mails no "esqueci minha senha" e observa a resposta: "enviamos o código" para um, "e-mail não encontrado" para outro. Em poucos minutos tem uma lista de quem usa um app de finanças. Os dois cenários parecem diferentes, mas pedem o mesmo cuidado: não deixar uma diferença sutil virar informação para quem ataca.

## O problema

Primeiro, um refresh token roubado não pode ser uma credencial duradoura. Segundo, cadastro, recuperação de senha e login não podem revelar se um e-mail tem conta. E eu queria tudo isso sem atrapalhar o uso normal: o usuário precisa ver uma lista estável de "dispositivos conectados" e conseguir encerrar um deles.

## Por que não era trivial

Rotacionar o token a cada uso, que é a recomendação comum, resolve só metade. Se o dono e o atacante têm o mesmo cookie, quem usar primeiro ganha o token novo. O outro, depois, apresenta um token já trocado. O servidor precisa decidir o que isso significa e agir. E como cada rotação cria uma linha nova no banco, a interface precisa de um identificador que não mude a cada troca, senão o "dispositivo" do usuário muda de id toda vez que ele abre o app.

Na enumeração, a diferença raramente está só no texto. Está no status HTTP, no envio ou não de um e-mail e, principalmente, no tempo. Verificar senha com bcrypt (um algoritmo de hash propositalmente lento) leva centenas de milissegundos. Se o servidor responde "senha errada" em 300 ms quando a conta existe e em 5 ms quando não existe, a mensagem igual não protege nada.

## A solução

### Famílias de sessão

Cada login cria uma família, um id que representa aquele dispositivo. O banco guarda só o hash SHA-256 do refresh token, nunca o token. Rotacionar insere uma linha nova com o mesmo id de família e revoga a anterior com o motivo "rotacionado". A interface lista famílias, não linhas, então o dispositivo continua o mesmo entre rotações, e encerrar um dispositivo é revogar a família.

### Detecção de reuso

Se chega um token cujo hash corresponde a uma linha revogada por rotação, alguém está usando um cookie que já foi trocado. Não dá para saber se é o dono ou o atacante, então revogo a família inteira com o motivo "reuso detectado". Os dois perdem a sessão e o dono legítimo entra de novo com senha. É o comportamento que a especificação de segurança do OAuth recomenda para refresh tokens rotativos. Troca de senha e troca de e-mail também revogam famílias, cada uma com seu motivo, o que facilita auditar depois por que uma sessão caiu.

### Respostas uniformes

No cadastro, pedir o código de verificação para um e-mail já cadastrado devolve o mesmo sucesso, sem gerar código e sem enviar e-mail. Se dois cadastros com o mesmo e-mail correrem em paralelo, a restrição de unicidade do banco resolve. Na recuperação de senha, e-mail inexistente também recebe sucesso sem envio, e a verificação do código devolve o mesmo erro de "código inválido" para conta inexistente e para código errado.

No login, o que importa é o custo. Quando o e-mail não existe, o servidor verifica a senha digitada contra um hash bcrypt falso, gerado uma vez, e devolve o mesmo erro de credencial inválida. Os dois caminhos pagam o mesmo preço de CPU. Por cima disso há bloqueio escalonado: a cada cinco falhas a conta fica travada por mais tempo, de cinco minutos até duas horas.

## Um exemplo

Uma linha do tempo fictícia de um cookie copiado:

| Tempo | Quem | Token apresentado | O que o servidor faz |
|---|---|---|---|
| 09:00 | Dono | R1 | Emite R2, revoga R1 como "rotacionado" |
| 09:20 | Atacante (copiou R1 às 08:55) | R1 | R1 está revogado por rotação: reuso. Revoga a família inteira |
| 09:21 | Dono | R2 | R2 também foi revogado. Vai para o login |
| 09:22 | Dono | senha | Nova família, novo dispositivo. O atacante ficou de fora |

Se a ordem fosse invertida (atacante às 09:00 e dono às 09:20), o resultado seria o mesmo: quem chega com o token velho derruba todo mundo, e só quem sabe a senha volta. O núcleo da decisão, em versão simplificada:

```ts
async function refresh(presented: string) {
  const hash = await sha256(presented)
  const session = await sessions.findByTokenHash(hash)
  if (!session) throw unauthorized()

  if (session.revokedAt) {
    // Token já trocado sendo usado de novo: alguém tem uma cópia.
    if (session.revokeReason === 'rotated') {
      await sessions.revokeFamily(session.familyId, 'reuse_detected')
    }
    throw unauthorized()
  }

  const next = randomToken()
  await sessions.rotate(session, await sha256(next)) // mesma família, linha nova
  return next
}
```

E o login, comparando os dois caminhos (tempos ilustrativos):

| Cenário | Status | Corpo | Tempo aproximado |
|---|---|---|---|
| E-mail existe, senha errada | 401 | "E-mail ou senha inválidos" | ~250 ms (bcrypt real) |
| E-mail não existe | 401 | "E-mail ou senha inválidos" | ~250 ms (bcrypt contra hash falso) |

## Resultado

Um cookie roubado deixa de ser credencial duradoura: na primeira colisão com o dono, a família cai. A lista de dispositivos fica estável entre rotações. E as três portas de entrada por e-mail não revelam quem tem conta, nem pelo texto, nem pelo status, nem pelo cronômetro.

## O que eu levo disso

Rotação sem detecção de reuso é meia solução: ela só funciona se o servidor lembrar dos tokens que já trocou. E para testar enumeração, comparo as duas respostas pelo corpo, pelo status, pelos efeitos colaterais e pelo tempo. Se alguma dessas quatro difere, o formulário ainda é um oráculo.
