---
title: "Sessão de app mobile em rede instável: renovar só quando o servidor pede"
summary: "No app da Salte em Expo, o canal de tempo real cai e volta o tempo todo no celular, e a sessão usa refresh token rotativo, que não perdoa uma renovação interrompida. Desenhei o app para renovar só quando o servidor diz que a sessão venceu e tratar todo o resto como rede."
project: salte
order: 14
tags: [Expo, React Native, WebSocket, Autenticação, Mobile]
---

Uma médica usa o app da Salte no celular entre um atendimento e outro. Ela sai do Wi-Fi da clínica, o 4G demora a pegar no elevador, e o canal de tempo real do app cai e volta algumas vezes em poucos minutos. Nada disso deveria mexer na sessão dela: a senha está certa, o token não venceu, ninguém fez logout. No celular, rede oscilando é o estado normal, e o app precisava ser desenhado para isso.

## O problema

O app mobile da Salte é feito em Expo, sobre React Native, e fala com a mesma API do front web. A sessão usa dois tokens: um de acesso, curto, e um de renovação (refresh), rotativo. A cada renovação, o servidor emite um par novo e invalida o refresh anterior. É um desenho seguro, mas que exige que cada renovação chegue inteira ao cliente: se o servidor conclui a rotação e a resposta se perde, o app fica com um refresh que já não vale.

O app tem um canal de tempo real por WebSocket, com volta para SSE (eventos enviados pelo servidor por HTTP) quando o socket não se sustenta. A primeira versão da reconexão renovava a sessão por precaução na primeira retentativa depois de cada queda, e o carregamento da conta e a troca de clínica tratavam qualquer 401 como sessão encerrada. Nos testes com rede degradada, ficou claro o custo dessa precaução: cada queda virava uma rotação de token, e cada rotação feita numa rede ruim era uma chance de perder a resposta no meio.

## Por que não era trivial

O WebSocket do React Native não mostra o status HTTP de uma abertura que falhou. Para o app, "a rede caiu", "o servidor está reiniciando" e "sua sessão venceu" chegam iguais: o socket não abriu. Sem distinguir os casos, renovar por precaução parece a única opção segura, e é por isso que a primeira versão fazia assim.

O 401 também não é uma coisa só. Ele pode significar token de acesso vencido, que se resolve renovando, ou uma recusa que nada tem a ver com a sessão, como faltar permissão naquela clínica. Encerrar a sessão no segundo caso joga a pessoa no login por um problema que o login não resolve.

E o tempo-limite da renovação precisa considerar que o servidor pode estar concluindo a rotação enquanto o cliente espera. Com o tempo-limite de uma leitura comum, numa rede lenta, o app desistiria antes da hora.

## A solução

### Perguntar à rota em vez de adivinhar

Na primeira retentativa de cada queda, em vez de renovar a sessão, o app sonda a mesma rota do socket por HTTP comum. Sem o cabeçalho de upgrade, a rota responde de um jeito que diz exatamente o que está acontecendo:

- **426** (o servidor espera um upgrade): a sessão está boa, foi só rede. O socket reabre sem renovar nada.
- **401 renovável**: o corpo de erro traz um detalhe que diz "sessão expirada". O cliente HTTP renova e repete a chamada sozinho, e o socket reabre.
- **Sessão encerrada de vez**: o app para de tentar e leva a pessoa ao login.
- **503**: o serviço de tempo real está indisponível, e o app vai direto para o SSE.
- Qualquer outro erro, inclusive falta de rede, reabre o socket no próximo intervalo, sem renovar.

A sonda acontece uma vez por queda. O intervalo entre tentativas dobra de 2 segundos até 60, com variação aleatória de 20% para cima ou para baixo, para que muitos aparelhos não voltem todos no mesmo instante. Na terceira falha seguida, o app usa SSE por dez minutos e volta a sondar o socket ao lado dele.

### Só a sessão vencida encerra a sessão

O carregamento da conta e a troca de clínica encerram a sessão só quando a camada HTTP diz que ela acabou de vez. Um 401 que não é de sessão vencida mantém a pessoa logada, marca a falha e mostra "Não deu para carregar suas permissões nesta clínica. Tente de novo." Quando a sessão acaba mesmo, o app explica: "Sua sessão expirou. Entre de novo."

### Uma renovação não pode ser abandonada no meio

O tempo-limite da renovação é o de uma escrita, mais longo que o de uma leitura. Abortar uma renovação que o servidor ainda está concluindo perde a rotação e revoga a sessão.

Do lado do servidor, uma tolerância curta cobre a resposta perdida: se o mesmo refresh volta em até 30 segundos, do mesmo aplicativo (o mesmo user agent) e enquanto o par novo ainda não foi usado, a API responde de novo em vez de recusar. Uma repetição por rotação, no máximo.

## Um exemplo

A mesma tarde, com a primeira versão e com o desenho final, em valores ilustrativos:

```text
14:02:10  socket cai (elevador)
          primeira versão: retentativa em 2 s com renovação de sessão
          desenho final: sonda HTTP da rota do socket
14:02:12  sonda responde 426: sessão boa, socket reabre, nenhuma renovação
14:05:40  socket cai de novo, rede lenta
          primeira versão: renovação sai, o app desiste em 10 s, o servidor conclui em 12 s
                 o app fica com o refresh antigo; próxima renovação: sessão revogada
          desenho final: sonda sem resposta, reabre em 2 s, 4 s, 8 s, sem renovar
14:06:00  rede volta, socket abre
16:30:00  token de acesso vence; a sonda recebe 401 com detalhe "expirada"
          cliente HTTP renova uma vez, repete, socket abre
```

A classificação que decide se a sessão acabou:

```ts
type Probe = { status: number; detail?: string } | 'network-error';

const RENEWABLE_401_DETAILS = new Set(['Access token expired']);

function nextStep(probe: Probe): 'reopen' | 'renew-then-reopen' | 'sse' | 'sign-in' {
  if (probe === 'network-error') return 'reopen';
  if (probe.status === 426) return 'reopen'; // a sessão está boa, só faltou o upgrade
  if (probe.status === 401 && probe.detail && RENEWABLE_401_DETAILS.has(probe.detail)) {
    return 'renew-then-reopen';
  }
  if (probe.status === 401) return 'sign-in';
  if (probe.status === 503) return 'sse';
  return 'reopen';
}
```

No app de verdade, o 401 que não é renovável chega como "sessão encerrada" pela camada HTTP, e os detalhes renováveis vêm de um pacote compartilhado entre a API e os clientes, para que os dois lados nunca leiam o mesmo texto de jeitos diferentes.

## Resultado

A rede oscilando não mexe na sessão. O app só renova quando o servidor diz que precisa, uma vez por queda, e só manda alguém ao login quando a sessão acabou de verdade, explicando por quê. Cada regra virou teste: a queda que reabre sem renovar, o 401 renovável que renova uma vez só mesmo repetido, o 401 não renovável que não renova, o 5xx que volta no intervalo e o aviso que só aparece quando deve.

## O que eu levo disso

Num celular, rede ruim é o estado normal, não a exceção. Toda ação que gasta algo irreversível, como uma rotação de token, precisa ser disparada por um sinal inequívoco do servidor, nunca por precaução. Quando a plataforma esconde a informação, como o WebSocket esconde o status, vale perguntar de outro jeito antes de agir no escuro.
