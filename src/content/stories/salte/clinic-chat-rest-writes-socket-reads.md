---
title: "Chat interno da clínica: escrita por REST, WebSocket só para avisar"
summary: "A equipe da clínica precisava conversar dentro do sistema, sobre pacientes, sem que a mensagem passasse por um atalho com menos regras que o resto da API. Fiz toda escrita passar pelo REST e deixei o WebSocket só para avisar."
project: salte
order: 8
tags: [WebSocket, Durable Objects, PostgreSQL, AES-GCM, Tempo real]
---

Uma enfermeira termina a triagem e quer avisar o médico que o paciente da sala 3 chegou com a pressão alta. Hoje ela faria isso pelo WhatsApp pessoal, com o nome do paciente numa conversa que a clínica não controla. Quando a Salte ganhou um chat interno, o pedido era simples: conversa um a um entre profissionais da mesma clínica, com áudio, documento, confirmação de leitura e indicador de "digitando". A parte difícil era fazer isso sem abrir uma porta lateral na API.

## O problema

Chat parece pedir WebSocket para tudo: o cliente manda a mensagem pelo socket, o servidor grava e distribui. Num ERP de saúde, isso cria um segundo caminho de escrita. A API REST da Salte já tinha, em toda rota, autenticação, checagem de vínculo com a clínica, limite de requisições, validação do corpo e transação. Um handler de mensagens no socket teria de repetir tudo isso, e qualquer esquecimento viraria uma forma de gravar dado clínico sem as regras do resto do sistema.

Havia também a questão do dado em si. Mensagem entre profissionais fala de paciente. Ela não pode ficar em texto puro no banco nem num arquivo público.

## Por que não era trivial

Em Cloudflare Workers, conexão WebSocket de longa duração mora num Durable Object, um objeto com identidade única e estado próprio que a Cloudflare garante existir em uma só instância por vez. Isso resolve a distribuição, mas tenta a pôr lógica demais ali dentro: validar, cifrar, gravar no Postgres. Fazer isso afunila a conversa inteira numa única instância e duplica código que já existe no Worker.

Os detalhes de tempo real também mordem. Duas pessoas abrindo a mesma conversa ao mesmo tempo podem criar duas conversas. Uma confirmação de leitura atrasada pode "desler" mensagens. E um socket que cai precisa voltar sem perder nada.

## A solução

### REST escreve, o socket só empurra

Toda mudança persistente passa por rota REST: enviar, editar, apagar, reagir, marcar como lida, fixar. Elas atravessam a mesma pilha de qualquer outra rota: autenticação, vínculo com a conversa, limite de requisições, validação com Zod e transação. O WebSocket é só de saída. A mensagem que chega do cliente pelo socket é ignorada de propósito. Até o "digitando" vai por REST, com um sinal a cada quatro segundos e validade de cinco.

Esse é o desenho que Slack, Discord e Linear usam, e não é uma concessão. A regra ficou escrita na documentação do módulo: se um evento precisa de validação, permissão ou persistência, ele é rota REST, nunca mensagem de socket.

### Um Durable Object por clínica, sem acesso ao banco

Cada clínica tem um Durable Object que funciona como hub de distribuição. Cada pessoa abre um único socket por clínica, e ele carrega os eventos de todas as conversas dela; o cliente lê o id da conversa no evento para saber onde desenhar. O objeto não fala com o banco. Ele guarda só estado efêmero: quem está digitando e quem está online.

Depois que o REST grava no Postgres, o Worker pede ao objeto para avisar os participantes, sempre excluindo quem originou o evento, que já tem o resultado na resposta HTTP. Se o objeto falhar, a resposta REST continua valendo, e os outros participantes se acertam ao reconectar, buscando as mensagens desde o último cursor. O Postgres é a fonte da verdade; o socket é um atalho de entrega.

### Conteúdo cifrado na camada de serviço

O texto da mensagem e a chave do arquivo de mídia são gravados cifrados com AES-256-GCM. A cifra acontece na camada de serviço: o repositório recebe e devolve bytes e não sabe nada de criptografia. Áudio, imagem e documento vão para o R2 sem URL pública e sem link pré-assinado. O download passa pelo Worker, com a mesma autenticação de qualquer rota.

### Uma conversa por dupla, decidida pelo banco

A conversa direta tem uma chave derivada do par de pessoas, sempre calculada com os ids em ordem, para que "A fala com B" e "B fala com A" deem a mesma chave. Um índice único parcial garante uma conversa por dupla dentro da clínica. Se dois pedidos correm, um insere, o outro recebe violação de unicidade e lê a conversa que acabou de nascer.

### Confirmação de leitura que só anda para frente

O ponteiro de "lido até aqui" só avança. O update tem a condição de o novo id ser maior que o atual, e como os ids são UUIDv7, ordenados pelo tempo, comparar ids é comparar momentos. Um cliente atrasado ou malicioso não consegue voltar o ponteiro e inflar o contador de não lidas dos outros. Se nada avançou, nenhum evento é distribuído.

## Um exemplo

Uma linha do tempo fictícia, com a enfermeira (E) e o médico (M) na mesma clínica:

```text
t=0 ms     E envia "Paciente da sala 3 com PA 16x10" via POST
t=0 ms     autenticação, vínculo com a conversa, limite, validação
t=6 ms     texto cifrado, INSERT na transação, COMMIT
t=7 ms     resposta 201 para E, com a mensagem já montada
t=8 ms     Worker pede ao objeto da clínica: avise M, exclua E
t=9 ms     M recebe "message:new" pelo socket e desenha a bolha
t=2 s      M abre a conversa: POST de leitura com o id da mensagem
t=2 s      UPDATE avança o ponteiro; E recebe "receipt:read"
```

O ponteiro de leitura é protegido assim:

```sql
UPDATE participants
   SET last_read_id = $3
 WHERE conversation_id = $1
   AND user_id = $2
   AND (last_read_id IS NULL OR last_read_id < $3);
-- 0 linhas afetadas: confirmação velha, nada a distribuir
```

Se o socket de M estivesse caído às 9 ms, nada se perderia: ao reconectar, o app pede as mensagens depois do último cursor que conhece e recebe a da enfermeira do Postgres.

## Resultado

A clínica ganhou um chat com áudio, documento, reações, resposta a mensagem, confirmação de entrega e leitura e presença online, e nenhum desses recursos abriu um caminho de escrita fora das regras da API. Quem perde o vínculo com a clínica perde também o acesso ao chat, pela mesma checagem que protege o resto da API. Também integrei a tela de mensagens do front web à API nova, com envio de mídia e forma de onda de áudio calculada no cliente.

O modelo de dados já aceita conversa em grupo, mesmo com o produto começando no um a um. Deixei isso registrado para ninguém simplificar o esquema e fechar essa porta.

## O que eu levo disso

Tempo real não precisa de um segundo backend. Quando o caminho de escrita já tem as regras certas, o socket pode ser só um aviso de que algo mudou, e a verdade continua num lugar só. Distribuição é melhor esforço; persistência não é.
