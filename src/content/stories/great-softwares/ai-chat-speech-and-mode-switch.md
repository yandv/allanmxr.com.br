---
title: "Segurar no streaming a fala do assistente que só narra bastidor"
summary: "Um assistente que trabalha chamando ferramentas tende a narrar bastidores, repetir frases e executar trocas destrutivas sem perguntar. Fiz o chat filtrar essa narração enquanto a resposta chega e exigir confirmação em código antes de qualquer troca que apague conteúdo."
project: great-softwares
order: 4
tags: [LLM, Agentes de IA, Streaming, Tool calling, Prompt engineering]
---

Imagine uma pessoa que abre o chat do editor e pede "transforma essa página num blog". A resposta começa a aparecer na tela: "Vou anotar suas preferências antes de começar." Uma pausa. "Vou anotar suas preferências antes de começar. Pronto, agora vou transformar a página." A primeira frase fala de uma ferramenta interna de memória que ela nunca precisaria ver, e ainda sai duas vezes. Ou alguém pede para voltar uma apresentação para página comum, e o assistente faz na hora, descartando os slides sem perguntar. Esses eram os dois comportamentos que o desenho do chat precisava impedir.

## O problema

O chat do editor do Great Pages cria e altera páginas chamando ferramentas: escrever na memória da sessão, editar blocos, trocar o tipo da página, fazer uma pergunta à pessoa, encerrar com um resumo. Dois comportamentos do modelo precisavam de tratamento.

O primeiro era de fala. O modelo anunciava em texto a chamada de ferramentas silenciosas (aquelas cujo efeito a pessoa não precisa acompanhar) e, ao retomar, repetia a mesma abertura. Uma frase como "Aqui está o resumo:" saía colada à mensagem final que vinha logo depois, dizendo a mesma coisa.

O segundo era de ação. A ferramenta que transforma a página em blog, quiz ou apresentação, ou volta para página comum, às vezes destrói conteúdo. Nada impedia o modelo de chamá-la sem perguntar.

## Por que não era trivial

- **A resposta chega em streaming.** Quando eu descubro que o texto era só um anúncio de bastidor, parte dele já foi para a tela. Não dá para desfalar.
- **A informação chega na ordem errada.** O texto vem antes da chamada de ferramenta. Só no fim da resposta sei se aquela frase era fala de verdade ou narração de algo silencioso.
- **Uma regra no prompt é um pedido, não uma garantia.** Basta o modelo errar uma vez para um blog inteiro sumir.
- **Algumas condições só o servidor conhece**, como se a conta tem o recurso de sites liberado. O cliente não é fonte confiável disso.

## A solução

### Reter a fala curta até saber o que ela é

Para a audiência humana, o motor do agente segura o começo de cada resposta num buffer até aparecer a primeira quebra de linha ou até passar de 280 caracteres. Uma resposta longa ou com várias linhas é fala de verdade e flui normalmente. Se o provedor avisa uma ferramenta que não é silenciosa, o buffer também é liberado na hora.

Se a resposta termina sem nada além de chamadas silenciosas, o texto retido vai para uma área de espera:

- se a próxima resposta traz texto, o retido é descartado, porque era bastidor ou a mesma fala reescrita;
- se não traz, o retido sai no lugar dela;
- se o laço termina, ele é liberado antes do fecho, e num cancelamento é descartado sem aparecer.

A primeira versão retinha demais e travava o streaming de respostas normais. Restringi a retenção a avisos curtos de uma linha, e a fala que já foi à tela nunca é puxada de volta. O texto retido também nunca vai para log: registro só quantos caracteres, e se foi retido, liberado ou descartado.

Para o anúncio colado à mensagem final, a regra é estreita de propósito. Se a resposta tem uma única chamada, de uma ferramenta que encerra o turno com mensagem preenchida, e o texto retido termina em dois-pontos, ele é tratado como anúncio e descartado. Uma frase completa sem dois-pontos continua sendo fala. Para a abertura repetida, corto o prefixo duplicado, sempre em fronteira de palavra. Cortar no meio produzia frases quebradas.

### Trava em código para a troca destrutiva

A ferramenta de troca de modo recebe o modo alvo e uma estratégia: transformar o conteúdo existente ou acrescentar ao lado. Antes de qualquer escrita, ela passa por recusas em ordem fixa, todas em código:

1. sem confirmação do servidor de que o recurso está liberado na conta, não troca, e a mensagem distingue falha momentânea de recurso não contratado;
2. apresentação com a estratégia de acrescentar é recusada, porque as duas coisas não convivem;
3. pedir o modo em que a página já está gera uma resposta de uma frase;
4. trocar de ou para apresentação, ou de blog para página, é destrutivo e exige confirmação.

Quem decide se a conta tem o recurso é o servidor, que consulta a lista de recursos da conta com a autorização da própria requisição e guarda o resultado por 5 minutos. A confirmação é uma pergunta pronta, com identificador fixo, e só vale se a resposta da pessoa chegou depois da recusa e depois da última mensagem dela. Na troca de blog para página, a pergunta é o que fazer com os artigos, com "manter" como opção recomendada.

## Um exemplo

Linha do tempo de um turno em que a pessoa pede para transformar uma apresentação em página:

| t | O que acontece | O que a pessoa vê |
|---|---|---|
| 0 ms | Modelo começa: "Vou registrar sua preferência" | nada ainda (buffer, uma linha, menos de 280 caracteres) |
| 400 ms | Resposta fecha só com a chamada de memória, que é silenciosa | nada (texto vai para a espera) |
| 900 ms | Modelo chama a troca de modo para página, estratégia transformar | nada |
| 905 ms | Ferramenta recusa: saída de apresentação é destrutiva | nada |
| 1,2 s | Modelo responde com texto e a pergunta pronta | "Transformar em página vai descartar os slides. Quer continuar?" |
| 1,2 s | Texto em espera é descartado, porque a resposta nova trouxe fala | a frase sobre preferência nunca aparece |
| 8 s | Pessoa responde "sim" | sua resposta |
| 8,6 s | Modelo chama a troca de novo; a confirmação é posterior à recusa e à última mensagem | a página muda de tipo |

Se no passo das 8 s a pessoa tivesse mandado outra mensagem em vez de responder, a confirmação antiga deixaria de valer e a troca seria recusada de novo.

## Resultado

O chat fala do que importa e pergunta antes de destruir conteúdo. Desistir de uma troca já feita é voltar com o desfazer até antes dela. Cada ponto tem teste: retenção, descarte, liberação no fim do laço, recusas na ordem certa e validade da confirmação.

## O que eu levo disso

Coloque a trava onde o erro custa caro, no código da ferramenta, e deixe o prompt como orientação. Em streaming, decida o que reter pelo que você sabe antes de mostrar o primeiro caractere, e mantenha essa janela pequena: reter demais estraga a experiência que você queria proteger.
