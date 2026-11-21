---
title: "Convite de equipe como contrato pendente: perfil de acesso e assento do plano"
summary: "Convidar alguém para uma clínica parece só mandar um e-mail, mas o convite promete um cargo e, às vezes, uma vaga limitada do plano. Desenhei o convite para carregar o perfil escolhido e reservar o assento de profissional de saúde até ser aceito ou cancelado."
project: salte
order: 7
tags: [Multi-tenant, Permissões, PostgreSQL, Planos e limites, Hono]
---

A dona de uma clínica abre a tela de equipe, convida uma pessoa nova, escolhe a ocupação "vendedor" e o perfil de acesso "comercial". A pessoa pode aceitar no mesmo minuto ou dois dias depois, já tendo conta na Salte ou criando uma pelo link. Nesse intervalo, a dona pode reenviar o convite com outro perfil, corrigir o e-mail ou desistir. Quando eu desenhei esse fluxo, a pergunta era: o que exatamente o convite promete, e como garantir que a promessa chega inteira ao outro lado?

## O problema

Na Salte, quem entra numa clínica tem duas coisas diferentes: a ocupação, tirada do catálogo da CBO (a Classificação Brasileira de Ocupações), e o perfil de acesso, que decide o que a pessoa vê e faz no ERP. Elas costumam andar juntas, mas não são a mesma coisa. Um enfermeiro pode ter perfil de profissional de saúde; um gestor pode vir de várias ocupações.

Na primeira versão do fluxo, o convite guardava só a ocupação, e o perfil era derivado dela no aceite. Os testes de ponta a ponta com combinações de ocupação e perfil mostraram o limite dessa abordagem: para algumas ocupações, a derivação caía num perfil diferente do escolhido, como um vendedor entrando com perfil de recepção. Derivar não bastava; o perfil precisava viajar no convite.

A segunda restrição vem do plano. A clínica tem um limite de profissionais de saúde, porque esse é o assento que mais pesa no produto. Se só membros contassem nesse limite, uma clínica com uma vaga sobrando poderia mandar cinco convites, e os cinco aceites disputariam um lugar só. O convite pendente também precisava ocupar vaga.

## Por que não era trivial

Gravar o perfil no convite resolve a primeira parte, mas o convite tem vida própria. Ele pode ser reenviado com outro perfil, ter o e-mail corrigido, ser cancelado ou expirar. Cada uma dessas transições mexe no que o convite promete.

O aceite também tem dois caminhos: a pessoa que já tem conta na Salte e entra em mais uma clínica, e a pessoa que cria a conta pelo próprio convite. Os dois precisam terminar no mesmo estado, com o mesmo rastro de auditoria.

E a contagem de assentos tem uma armadilha de autocontagem. Se o convite pendente ocupa um assento, então no momento do aceite ele não pode contar de novo, senão a última vaga recusa a própria pessoa que a reservou.

## A solução

### O convite carrega o perfil

O convite passou a guardar o perfil escolhido e também o produto de onde saiu: o ERP ou o app de agentes da Salte, que tem tela de entrada própria. Assim, o link do convite e o link de reenvio apontam sempre para o lugar certo.

No reenvio, o perfil escolhido vence o perfil da primeira carta. Quem reenviou mudou de ideia, e o convite acompanha.

### Os dois aceites fixam o perfil do mesmo jeito

O cadastro de membro, por desenho, não grava o perfil. Então os dois caminhos de aceite passam por um único passo que fixa o perfil do convite no membro recém-criado e grava a mesma linha de auditoria de uma troca manual de perfil. Para quem audita, "entrou como comercial pelo convite" e "virou comercial por alteração" têm a mesma forma.

### Duas portas para o assento de saúde

A conta do assento ficou explícita em duas portas:

- **No convite**, a pergunta é "ainda há vaga, contando quem já está e quem já foi convidado?". Membros que ocupam assento mais convites pendentes e não expirados que ocupam assento, comparados com o limite do plano.
- **No aceite**, a pergunta é "há vaga para esta pessoa entrar?". Aqui os convites pendentes não entram na conta, porque o convite que está sendo aceito é um deles.

Um convite ocupa assento se a ocupação é de saúde no catálogo ou se o perfil escolhido é de profissional de saúde. A segunda condição importa: sem ela, um recepcionista convidado com perfil de saúde entraria sem ocupar vaga.

### Reenvio que muda o perfil

Se um convite pendente que não ocupava assento é reenviado com perfil de saúde, ele passa a ocupar, então a porta do convite é checada. Se ele já ocupava, não é checado de novo, para não se contar duas vezes e ser recusado no limite.

Junto, entreguei o que faltava para o convite ser gerenciável: cancelar um convite pendente e corrigir o e-mail de um convite enviado para o endereço errado. As duas rotas têm limite de tamanho de corpo, como o resto da API.

## Um exemplo

Uma clínica fictícia com plano de três profissionais de saúde, dois já na equipe:

| Passo | Ação | Membros com assento | Convites pendentes com assento | Resultado |
| --- | --- | --- | --- | --- |
| 1 | Convida uma enfermeira | 2 | 0 | Aceito: 2 + 0 < 3 |
| 2 | Convida um fisioterapeuta | 2 | 1 | Recusado: 2 + 1 = 3 |
| 3 | Convida um vendedor, perfil comercial | 2 | 1 | Aceito: não ocupa assento |
| 4 | Enfermeira aceita | 2 | 1 (o dela) | Aceito: 2 < 3, pendentes fora da conta |
| 5 | Reenvia o convite do vendedor com perfil de saúde | 3 | 0 | Recusado: 3 + 0 = 3 |

As duas portas, em forma resumida:

```ts
type Door = 'invite' | 'accept';

function hasHealthSeat(
  limit: number | null,
  membersHoldingSeat: number,
  pendingInvitesHoldingSeat: number,
  door: Door,
): boolean {
  if (limit === null) return true; // plano sem limite de assento
  // no aceite, o convite que está entrando é um dos pendentes
  const promised = door === 'invite' ? pendingInvitesHoldingSeat : 0;
  return membersHoldingSeat + promised < limit;
}
```

No passo 4, se a porta do aceite contasse os pendentes, a conta seria 2 + 1 = 3 e a enfermeira seria recusada pela própria vaga que o convite dela reservou.

## Resultado

O perfil escolhido na tela é o perfil com que a pessoa entra, nos dois caminhos de aceite, com auditoria igual à de uma troca manual. O limite de profissionais de saúde do plano vale também para promessas: não dá para convidar além do que cabe e só descobrir no aceite. Cada caso virou teste de ponta a ponta, inclusive o do reenvio que troca o perfil.

## O que eu levo disso

Um convite é um contrato pendente, e tudo que ele promete precisa estar nele, não ser deduzido depois. E toda conta de vagas tem duas perguntas diferentes, "ainda posso prometer?" e "posso cumprir esta promessa?". Misturar as duas é o jeito mais comum de recusar a pessoa certa ou aceitar a pessoa a mais.
