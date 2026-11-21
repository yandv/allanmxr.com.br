---
title: Trocar o celular do 2FA sem deixar a conta desprotegida
summary: "Sem um fluxo de troca, quem muda de celular precisaria desligar o 2FA e deixar a conta desprotegida justo no momento mais exposto. Criei a troca e a recuperação de aparelho sem nenhuma janela em que a conta fique sem segundo fator."
project: great-softwares
order: 13
tags: [2FA, TOTP, Segurança, Cloudflare Workers, Concorrência]
---

Imagine um cliente do Great Apps que compra um celular novo, transfere os aplicativos e só percebe no login seguinte: o aplicativo autenticador não veio junto. O celular antigo ainda está na gaveta, funcionando. Ele quer fazer o óbvio, que é apontar o 2FA para o aparelho novo. Sem um caminho próprio para isso, a única saída seria desativar o 2FA e ativar de novo, o que deixa a conta sem segundo fator justamente no momento em que ela está mais exposta.

## O problema

O 2FA do Great Apps é um serviço pequeno num Cloudflare Worker, baseado em TOTP: o código de seis dígitos que o aplicativo autenticador gera a partir de um segredo compartilhado e do horário atual, trocando a cada 30 segundos. O serviço gerava o segredo, mostrava o QR code, confirmava a ativação e verificava o código no login.

Faltavam dois fluxos da vida real: trocar de aparelho tendo o antigo em mãos e recuperar o acesso com um código de backup quando o aparelho antigo se perdeu.

## Por que não era trivial

Trocar o segundo fator é uma operação de autenticação. Tudo que protege o login precisa proteger a troca também, contra alguém que já tem a senha. Na prática, eram quatro problemas concretos:

- a troca não pode invalidar o aparelho atual antes de o novo provar que funciona, senão o cliente se tranca para fora no meio do processo;
- o limite de tentativas precisa resistir a requisições paralelas. Um "ler contador, somar um, gravar" perde contagens quando dez requisições chegam juntas;
- um código TOTP aceito não pode ser reaproveitado dentro da janela em que ainda é válido;
- o segredo TOTP e os códigos de backup não podem ficar legíveis no banco.

## A solução

### Segredo pendente

A troca exige um código do aparelho atual. Com ele validado, eu gero um segredo novo e códigos de backup novos e guardo os dois como pendentes. O login só lê o segredo ativo, então o pendente nunca autentica ninguém. Só a confirmação, com um código gerado pelo aparelho novo, promove o pendente a ativo. Se o cliente desistir no meio, o aparelho antigo continua funcionando como sempre.

A recuperação por código de backup usa o mesmo desenho. O código de backup é consumido, o segredo novo fica pendente, e o antigo só deixa de valer quando o novo é confirmado.

### Tentativas reservadas antes da verificação

Cada tentativa é reservada antes de o código ser checado, com um `UPDATE` condicionado ao contador e à versão da linha que eu li. Se duas requisições leram o mesmo contador, só uma consegue gravar. A que alcança a quinta falha grava o bloqueio de 15 minutos na mesma instrução. Só um acerto zera o contador.

Quem perde a corrida recebe um erro de conflito explícito. O servidor não repete sozinho, e um conflito não conta como tentativa, mas também não verifica o código. Assim não existe caminho em que uma rajada paralela teste mais códigos do que o limite permite.

### Código de uso único

O passo de tempo do código aceito é gravado na linha com outro `UPDATE` condicional: só passa se o passo for maior que o último usado. Se nenhuma linha foi afetada, o código já foi usado e a resposta diz exatamente isso. Como a verificação aceita uma janela de um passo para cada lado, para tolerar relógio de celular atrasado, essa trava é o que impede o mesmo código de valer duas vezes nesses 90 segundos.

### Segredos em repouso

O segredo TOTP passou a ser cifrado com AES-GCM, e os códigos de backup passaram a ser guardados como HMAC-SHA256 com pepper (uma chave secreta extra, guardada fora do banco). As chaves ficam no Secrets Store da Cloudflare, fora do código e fora do banco. Como já existiam registros no formato antigo, mantive a leitura dos dois formatos durante a transição e escrevi uma migração em lotes que usa o mesmo compare-and-set por linha. Uma linha alterada entre a leitura e a escrita é pulada e fica para a próxima passada. Encerrada a transição, a migração e a leitura antiga saem do código.

### Avisos e limite por IP

Troca concluída, recuperação usada, bloqueio por tentativas e desativação disparam e-mail para o titular. A verificação de código também passou a dividir com o login o limitador por IP, para não existir uma segunda porta sem teto.

## Um exemplo

A reserva de tentativa, em SQL com nomes genéricos:

```sql
-- $2 é o contador que eu li, $3 a versão da linha que eu li
UPDATE two_factor
SET failed_attempts = $2 + 1,
    locked_until = CASE WHEN ($2 + 1) % 5 = 0
                        THEN now() + interval '15 minutes'
                        ELSE locked_until END,
    version = version + 1
WHERE user_id = $1
  AND failed_attempts = $2
  AND version = $3
  AND (locked_until IS NULL OR locked_until < now())
RETURNING failed_attempts, locked_until;
```

Agora um atacante com a senha disparando seis códigos em paralelo, todos lendo o contador em 3:

| Requisição | Leu | Resultado da reserva | Código verificado? |
|---|---|---|---|
| 1 | 3 | grava 4 | sim, errado |
| 2 a 6 | 3 | zero linhas, conflito | não |
| 7 (nova leitura) | 4 | grava 5 e bloqueia por 15 min | sim, errado |
| 8 | 5 | bloqueada antes de reservar | não |

Sem a reserva condicional, as seis teriam lido 3, gravado 4 e verificado seis códigos diferentes, gastando uma única tentativa do limite.

E a troca de aparelho, passo a passo:

1. `t=0` cliente envia código do celular antigo, segredo novo fica pendente;
2. `t=20s` QR code novo escaneado no celular novo;
3. `t=35s` cliente envia código do celular novo, pendente vira ativo, e-mail de aviso sai;
4. se o passo 3 nunca acontecer, o celular antigo segue valendo.

## Resultado

A troca de aparelho e a recuperação passaram a funcionar sem nenhuma janela em que a conta fique sem segundo fator ou aberta para força bruta. Os cenários de rajada concorrente, código reutilizado, bloqueio e migração de formato ficaram cobertos por testes automatizados. O desenho e o modelo de ameaça ficaram documentados junto do código, para quem mexer depois entender por que cada trava existe.

## O que eu levo disso

Fluxo de autenticação com estado deve ser escrito como transições condicionais no banco, não como lógica em memória. A condição no `WHERE` é a única coisa que continua verdadeira quando dez requisições chegam no mesmo milissegundo.

E toda mudança de credencial precisa de um estado pendente que não autentica nada até ser provado. É o que permite ao cliente errar, desistir ou perder a conexão no meio sem se trancar para fora.
