# Source request

# Missão

Quero que você atue como **Staff Software Engineer / Systems Architect** e desenvolva um **plano de implementação completo, pragmático e diretamente executável** para um projeto chamado provisoriamente de **AI Window Manager**.

Neste momento, **não implemente o produto inteiro**. O objetivo principal desta execução é produzir um plano técnico de altíssima qualidade que possa posteriormente ser entregue a um agente de programação para implementação praticamente sem decisões arquiteturais pendentes.

Antes de propor a arquitetura, faça pesquisa, investigue meus workflows existentes usando o **connector do GitHub** e entenda como os provedores-alvo funcionam atualmente.

---

# 1. Ideia central

Quero criar um serviço self-hosted que gerencie **janelas temporais de quota/uso de provedores de IA**.

Exemplo conceitual:

Um provedor possui uma janela de quota de aproximadamente 5 horas iniciada a partir de determinada atividade.

Se eu normalmente começo a trabalhar às 12:00, pode ser vantajoso que exista uma janela iniciada anteriormente, por exemplo:

```text
08:00  janela inicia
12:00  começo a trabalhar
13:00  janela reseta
13:00  nova quota disponível
```

Assim posso iniciar uma sessão de trabalho ainda com praticamente toda a quota da janela anterior e ter um novo reset ocorrendo durante meu período de trabalho.

O produto existe para **gerenciar esse posicionamento temporal das janelas**, observar seu comportamento e fornecer informações suficientes para que o usuário escolha uma estratégia adequada.

---

# 2. Escopo correto do produto

É extremamente importante preservar o escopo.

O projeto é um:

> **AI usage window manager**

Ele NÃO deve se transformar em:

- orquestrador de agentes;
- gerenciador de prompts;
- roteador de LLMs;
- proxy universal de APIs;
- task manager;
- visualizador de memórias;
- painel de conversas;
- observability stack para agentes;
- sistema de billing completo;
- plataforma SaaS multiusuário;
- ferramenta para distribuir automaticamente tarefas entre modelos;
- substituto de Codex, Antigravity ou outros clientes.

A responsabilidade deve permanecer estreita:

```text
observar janela
      ↓
registrar estado
      ↓
calcular timing
      ↓
executar ação mínima quando suportado
      ↓
registrar resultado
      ↓
expor estado / métricas / configuração
```

Evite feature creep durante todo o planejamento.

---

# 3. Providers iniciais

O MVP deve começar somente com:

1. **OpenAI Codex**
2. **Antigravity**

Antes de desenhar os adapters, INVESTIGUE o comportamento atual dos dois serviços.

Não presuma que:

- ambos usam exatamente janelas de 5 horas;
- ambos iniciam a janela da mesma maneira;
- ambos possuem endpoint oficial de quota;
- ambos permitem descobrir exatamente o próximo reset;
- uma chamada arbitrária inicia uma janela;
- uma janela pode ser mantida ativa indefinidamente;
- os mecanismos atuais continuarão iguais.

Descubra, na medida do possível:

- modelo de quota;
- duração da janela;
- evento que inicia a janela;
- como o reset funciona;
- se existe rolling window ou fixed window;
- como quota restante é apresentada;
- se existe API oficial;
- se existe endpoint utilizado pelos clientes oficiais;
- autenticação necessária;
- possibilidade de consultar status sem consumir quota;
- possibilidade de iniciar uma janela de forma legítima e mínima;
- diferenças entre planos;
- limitações conhecidas;
- comportamento quando nenhuma janela está ativa.

Documente claramente a diferença entre:

```text
OFFICIAL / SUPPORTED
OBSERVED / INTERNAL
INFERRED
UNKNOWN
```

Nunca trate endpoint interno como contrato estável.

Pesquise documentação oficial, comportamento dos clientes e código público relevante quando existir.

---

# 4. Compliance e segurança

O projeto NÃO deve tentar:

- burlar rate limits;
- aumentar artificialmente a quota concedida;
- contornar billing;
- fabricar identidades;
- rotacionar contas;
- esconder tráfego;
- violar mecanismos antifraude.

O objetivo é apenas **posicionar temporalmente uma quota que o usuário já possui legitimamente**.

Analise explicitamente se algum mecanismo necessário pode violar Terms of Service de cada provider.

Se determinada automação não puder ser feita de maneira suportada, o adapter deve poder operar como:

```text
monitor-only
```

em vez de depender obrigatoriamente de hacks.

---

# 5. Self-hosting como requisito fundamental

Esse serviço NÃO deve depender da workstation onde Codex ou outro cliente está sendo usado.

A arquitetura desejada é:

```text
                    LAN / VPN
                       │
                       ▼
              ┌──────────────────┐
              │ AI Window Manager│
              │                  │
              │   Docker host    │
              └──────────────────┘
                 │     │      │
                 │     │      └── Web UI
                 │     └───────── metrics
                 └─────────────── scheduler
```

Ele deve poder ser executado 24/7 em um servidor doméstico.

O deployment preferido deve ser um **container Docker bem isolado**, idealmente administrável por Docker Compose.

A aplicação deve sobreviver a:

- reinicialização do container;
- reinicialização do host;
- falta temporária de internet;
- indisponibilidade do provider;
- mudança de timezone;
- horário de verão;
- falha em uma tentativa de ação;
- dados de quota temporariamente indisponíveis.

---

# 6. Analise primeiro meus projetos existentes

ANTES de escolher stack, estrutura de repositório ou workflows, utilize o **GitHub connector**.

Meu usuário no GitHub é:

```text
Nerver-zip
```

Analise uma amostra representativa dos meus repositórios atuais.

Procure especialmente padrões relacionados a:

- Docker;
- Docker Compose;
- serviços self-hosted;
- backends;
- C++;
- TypeScript;
- APIs;
- configuração;
- CI;
- testes;
- CMake quando relevante;
- package managers;
- estrutura de diretórios;
- scripts;
- Makefiles;
- Taskfiles;
- documentação;
- GitHub Actions;
- release/versionamento;
- lint;
- formatting;
- healthchecks;
- `.env`;
- exemplos de configuração;
- AGENTS.md;
- prompts;
- documentação para agentes;
- skills;
- workflows utilizados por agentes de programação.

Alguns projetos meus podem ter estilos diferentes. Não copie cegamente um único projeto.

Identifique **padrões recorrentes que claramente representam minha maneira de trabalhar**.

No plano final crie uma seção:

```text
Existing workflow conventions adopted
```

explicando:

- quais repositórios foram observados;
- quais convenções foram encontradas;
- quais devem ser reaproveitadas;
- quais não fazem sentido neste projeto.

---

# 7. Agent-native development

Quero que esse repositório seja agradável não apenas para humanos, mas também para **agentes de programação**.

Durante a análise dos meus outros projetos, procure como já estruturo trabalho para agentes.

Proponha uma estratégia para:

```text
AGENTS.md
docs/
skills/
```

ou outra estrutura que faça sentido.

Considere criar skills específicas do projeto, por exemplo, apenas se forem realmente úteis:

```text
skills/
  provider-adapter/
  docker-deployment/
  release/
  testing/
```

Não crie skills apenas por criar.

Uma skill deve encapsular conhecimento repetitivo e específico do projeto, como:

- como adicionar um novo provider;
- invariantes do scheduler;
- como testar time windows;
- convenções dos adapters;
- como atualizar schema/config;
- como validar Docker;
- como preparar releases.

Cada skill proposta deve dizer:

- quando deve ser usada;
- pré-condições;
- procedimento;
- arquivos normalmente envolvidos;
- validações obrigatórias;
- erros comuns;
- definição de pronto.

Também proponha o conteúdo e função do `AGENTS.md`.

O objetivo é que futuros agentes consigam entrar no repositório e trabalhar de forma consistente sem redescobrir toda a arquitetura.

---

# 8. Funcionalidades desejadas para o MVP

## 8.1 Providers

Interface comum para providers.

Algo conceitualmente próximo de:

```text
Provider
 ├── inspect()
 ├── capabilities()
 ├── trigger_window()
 └── health()
```

Não tome essa API literalmente. Projete a abstração correta.

O sistema deve suportar capabilities diferentes por provider.

Exemplo conceitual:

```text
can_query_usage
can_query_reset
can_trigger_window
trigger_consumes_quota
official_usage_api
official_trigger_api
```

Evite uma abstração que force todos os providers a fingirem possuir as mesmas capacidades.

---

# 9. Estado da janela

Modele explicitamente estados como:

```text
UNKNOWN
INACTIVE
ACTIVE
RESET_DUE
UNAVAILABLE
ERROR
```

ou proponha máquina de estados melhor.

Uma janela pode ter informações como:

```text
provider
started_at
expected_reset_at
actual_reset_at
usage_percent
remaining_percent
confidence
source
status
```

Nem todos os campos estarão disponíveis em todos providers.

Diferencie:

```text
observed timestamp
inferred timestamp
estimated timestamp
```

Isso é importante.

---

# 10. Scheduler

O scheduler é o coração do produto.

Não quero um scheduler gigantesco.

Para o MVP considere conceitos como:

### Manual

```text
Trigger now
```

### Target reset

Usuário informa:

```text
I want a reset around 13:00
```

Para uma janela de 5 horas:

```text
desired reset: 13:00
window length: 05:00

trigger target ≈ 08:00
```

### Desired work window

Exemplo:

```text
work:
  start: 12:00
  end: 23:00
```

O sistema pode sugerir um posicionamento interessante.

IMPORTANTE:

O sistema inicialmente pode **sugerir** ao invés de automaticamente implementar estratégias complexas.

Prefira comportamento previsível.

Não crie um solver genérico ou um scheduler de jobs distribuídos.

---

# 11. Estatísticas

Registrar histórico é parte importante do projeto.

Quero conseguir aprender como efetivamente consumo minhas quotas.

Considere armazenar eventos como:

```text
window detected
window started
window reset
usage sampled
trigger attempted
trigger succeeded
trigger failed
provider unavailable
configuration changed
```

A partir desses dados quero futuramente visualizar coisas como:

```text
quota consumed per window
quota consumed per day
average consumption
window lifetime
time until reset
usage by hour of day
number of windows used
trigger reliability
```

Também pode ser interessante detectar:

```text
Typical high-usage period: 14:00 → 00:30
```

Porém:

**não coloque machine learning no MVP.**

Estatística simples é preferível.

---

# 12. Persistência

Escolha uma solução pequena e apropriada.

SQLite é uma opção óbvia, mas analise antes de decidir.

Não introduza Postgres, Redis ou infraestrutura adicional sem um motivo muito forte.

O projeto deve permanecer simples de operar.

Projete:

- entidades;
- eventos;
- migrations;
- retenção;
- índices relevantes;
- timestamps;
- UTC vs timezone local;
- consistência após restart.

Inclua uma proposta concreta de schema.

---

# 13. Web UI

Quero uma página web pequena.

Não é um dashboard empresarial.

Ela deve permitir principalmente:

### Overview

```text
AI Window Manager

Codex
████████████████░░░░ 82%
Reset: 13:04
Window age: 03:52
Status: ACTIVE

Antigravity
██████████░░░░░░░░░░ 51%
Reset: ~16:20
Status: ACTIVE
```

### Schedule

Algo como:

```text
Desired reset:
[13:00]

Desired work period:
[12:00] — [00:00]
```

### Provider settings

- enable/disable;
- estratégia;
- polling interval;
- credenciais/configuração necessária;
- monitor-only vs automation quando aplicável.

### History / metrics

Somente algumas visualizações realmente úteis.

Não transforme isso em Grafana.

Evite dependências front-end pesadas sem necessidade.

Avalie se:

- server-rendered HTML;
- HTMX;
- pequeno frontend;
- TypeScript;
- ou outra solução

é mais adequada.

Justifique.

---

# 14. Metrics

Quero métricas acessíveis na rede.

Considere exposição compatível com Prometheus, por exemplo:

```text
ai_window_usage_ratio
ai_window_seconds_until_reset
ai_window_age_seconds
ai_window_trigger_total
ai_window_trigger_failures_total
ai_window_provider_up
```

Avalie cardinalidade.

Evite labels perigosos ou de alta cardinalidade.

A UI pode usar o banco/API diretamente; não precisa usar Prometheus internamente.

---

# 15. API

Projete uma API pequena apenas se necessária.

Possíveis endpoints conceituais:

```text
GET  /api/providers
GET  /api/providers/:id
POST /api/providers/:id/trigger
GET  /api/history
GET  /api/settings
PUT  /api/settings
GET  /metrics
GET  /health
```

Não trate essa lista como requisito rígido.

Questione quais endpoints realmente precisam existir.

---

# 16. Configuração

Pense em:

```yaml
timezone: America/Sao_Paulo

providers:
  codex:
    enabled: true

  antigravity:
    enabled: true

schedule:
  desired_reset: '13:00'
```

Mas também determine:

- o que pertence a arquivo;
- o que pertence ao banco;
- o que pode ser alterado pela UI;
- precedência entre env/config/database;
- quais campos exigem restart;
- quais mudanças são runtime.

Evite dois sistemas conflitantes de configuração.

---

# 17. Credenciais

Isso merece atenção especial.

Como o serviço estará em outro computador, descubra como cada provider autentica suas consultas.

Avalie:

- tokens;
- refresh tokens;
- cookies;
- OAuth;
- API keys;
- credenciais dos clientes;
- expiração;
- renovação;
- revogação.

Não quero colocar meu diretório `$HOME` inteiro dentro de um container.

Projete isolamento adequado.

Secrets devem:

- ficar fora da imagem;
- não aparecer em logs;
- não aparecer nas métricas;
- não ser enviados para o frontend;
- possuir permissões mínimas.

Considere Docker secrets ou mounts read-only quando aplicável.

---

# 18. Docker

Deployment deve ser uma prioridade de primeira classe.

Desenhe algo próximo de:

```text
docker compose up -d
```

e pronto.

Considere:

- imagem multi-stage;
- usuário não-root;
- filesystem read-only quando possível;
- volume apenas onde necessário;
- healthcheck real;
- graceful shutdown;
- restart policy;
- capabilities removidas;
- `no-new-privileges`;
- portas configuráveis;
- logging;
- persistência;
- secret mounts.

Minha intenção é eventualmente colocar isso em um homelab e possivelmente gerenciar pelo Dockge.

Considere isso no Compose sem criar dependência específica do Dockge.

---

# 19. Rede e acesso

A aplicação deve poder ser exposta apenas para:

- LAN;
- VPN;
- Tailscale;
- reverse proxy privado.

Não presuma exposição pública.

Projete defaults seguros.

Avalie se autenticação própria é necessária no MVP ou se bind privado + reverse proxy é suficiente.

Documente os trade-offs.

---

# 20. Time handling

Esse projeto depende pesadamente de tempo.

Trate isso como requisito crítico.

Quero regras explícitas para:

- armazenar timestamps em UTC;
- apresentar horário na timezone configurada;
- duration vs wall-clock;
- DST;
- reinício do daemon;
- clock drift;
- NTP;
- timers monotônicos;
- jobs perdidos durante downtime;
- ação prevista para horário que ocorreu enquanto o container estava desligado.

Exemplo:

```text
container deveria executar trigger às 08:00
host ficou offline 07:50 → 08:20
```

Defina comportamento explícito.

---

# 21. Reliability

Analise:

- retries;
- exponential backoff;
- jitter;
- circuit breaker, se realmente necessário;
- idempotência;
- duplicate trigger;
- provider timeout;
- malformed response;
- auth expiration;
- rate limiting.

Especialmente importante:

```text
trigger_window()
```

não pode disparar repetidamente porque o scheduler perdeu confirmação.

Defina invariantes.

---

# 22. Logging

Logs devem permitir entender:

```text
por que o scheduler tomou uma decisão?
```

Exemplo desejado:

```text
08:00:00 scheduler target_reset=13:00
08:00:00 codex expected_window=5h
08:00:00 decision=trigger
08:00:01 trigger success
08:00:03 detected reset_at=13:02
```

Sem vazar secrets.

Considere logs estruturados.

---

# 23. Observability

Não crie uma observability platform.

Quero somente:

```text
logs
health
metrics
history
```

Isso basta.

---

# 24. Testabilidade

O scheduler e lógica temporal devem ser altamente testáveis.

Evite código dependente diretamente de:

```text
now()
sleep()
```

espalhado pela aplicação.

Considere abstrações de clock.

Quero poder testar:

```text
given:
  now = 07:59
  desired_reset = 13:00
  duration = 5h

when:
  scheduler ticks

then:
  trigger scheduled ≈ 08:00
```

E também:

```text
restart
provider outage
missed trigger
DST transition
unknown reset
delayed provider response
duplicate poll
```

Defina uma matriz de testes.

---

# 25. Provider simulator

Avalie seriamente criar um:

```text
FakeProvider
```

ou simulator.

Isso permitiria desenvolver scheduler e UI sem gastar quota real.

Por exemplo:

```text
window_duration = 30s
quota = 100
consume_rate = configurable
```

Se fizer sentido, inclua no MVP de desenvolvimento, mas não necessariamente na build de produção.

---

# 26. Stack

NÃO escolha stack com base apenas no que é popular.

Primeiro:

1. analise meus repositórios;
2. entenda os requisitos;
3. considere simplicidade operacional;
4. considere tamanho da imagem;
5. considere segurança;
6. considere facilidade de testar tempo/scheduler;
7. considere desenvolvimento por agentes;
8. considere manutenção futura.

Tenho experiência principalmente com:

- C++;
- TypeScript;
- JavaScript;
- Linux;
- Docker;
- PostgreSQL;
- SQLite;
- Redis.

Não significa que todos devam ser usados.

Quero preferencialmente **uma aplicação pequena**, não cinco serviços.

Compare pelo menos 2 arquiteturas plausíveis e escolha uma.

---

# 27. Monólito pequeno é desejável

Minha preferência inicial é algo conceitualmente parecido com:

```text
              one container
                    │
        ┌───────────┼───────────┐
        │           │           │
    scheduler      API        Web UI
        │
     providers
        │
      SQLite
```

Não use microservices sem uma justificativa extraordinária.

---

# 28. Estrutura do repositório

Proponha uma árvore concreta.

Exemplo apenas ilustrativo:

```text
ai-window-manager/
├── src/
│   ├── providers/
│   ├── scheduler/
│   ├── storage/
│   ├── web/
│   └── metrics/
├── migrations/
├── tests/
├── docs/
├── skills/
├── Dockerfile
├── compose.yaml
├── AGENTS.md
└── README.md
```

Escolha a estrutura apropriada para a stack decidida.

Explique responsabilidades por diretório.

---

# 29. Separação arquitetural crítica

Mantenha estas três coisas separadas:

```text
Provider observation
        │
        ▼
Normalized window state
        │
        ▼
Scheduler decision
        │
        ▼
Provider action
```

O scheduler NÃO deve conhecer HTTP endpoints específicos de Codex ou Antigravity.

A UI NÃO deve conhecer mecanismos de autenticação dos providers.

O provider NÃO deve decidir sozinho a política de scheduling.

---

# 30. Confidence model

Como parte das informações será inferida, considere modelar confiança.

Exemplo:

```text
reset_at:
  value: 2026-09-14T16:00:00Z
  source: provider
  confidence: exact
```

versus:

```text
reset_at:
  value: 2026-09-14T16:00:00Z
  source: inferred_from_window_start
  confidence: estimated
```

Não precisa necessariamente ser exatamente esse schema.

Analise se vale a pena.

---

# 31. Recomendações, não “IA”

Com histórico suficiente o sistema pode fazer recomendações simples.

Exemplo:

```text
You usually consume 73% of Codex quota between 14:00 and 20:00.

Suggested reset target:
13:30
```

Faça isso através de estatística determinística.

Não adicione LLM ao projeto.

---

# 32. UX esperada

Quero abrir:

```text
http://ai-window.local/
```

e entender em segundos:

```text
qual janela está ativa?
quanto resta?
quando reseta?
qual será a próxima ação?
por que ela será tomada?
```

Essa é a UX fundamental.

---

# 33. MVP vs futuro

Faça uma separação rigorosa entre:

```text
MVP
v1.x
Possible future work
Explicitly out of scope
```

MVP deve ser pequeno o suficiente para ser implementado de maneira consistente por um agente.

Não jogue tudo para o MVP.

---

# 34. Threat model

Faça um threat model pequeno porém concreto.

Considere:

- roubo do volume;
- roubo do token;
- acesso à UI pela LAN;
- XSS/CSRF;
- container escape;
- supply-chain;
- malicious provider response;
- secrets em logs;
- secrets em crash dumps;
- permissões Docker.

Classifique riscos pragmaticamente.

---

# 35. Failure modes

Crie uma tabela de failure modes.

Exemplos:

```text
Provider mudou endpoint
Token expirou
Provider retornou 429
Quota endpoint indisponível
Servidor ficou offline
SQLite corrompido
Clock pulou
Trigger executado mas confirmação falhou
Trigger duplicado
Reset estimado estava incorreto
```

Para cada um, defina comportamento esperado.

---

# 36. ADRs

Identifique decisões que merecem Architecture Decision Records.

Provavelmente coisas como:

```text
ADR-001 Stack
ADR-002 Persistence
ADR-003 Provider adapter model
ADR-004 Scheduling semantics
ADR-005 Configuration ownership
ADR-006 Credential handling
```

Não escreva dezenas de ADRs.

Escolha somente decisões estruturalmente relevantes.

---

# 37. Documentação do projeto

Planeje pelo menos:

```text
README.md
docs/architecture.md
docs/providers.md
docs/scheduling.md
docs/security.md
docs/deployment.md
docs/development.md
```

A documentação deve explicar invariantes, não apenas comandos.

---

# 38. Estratégia de implementação

Produza um plano em fases concretas.

Por exemplo:

```text
Phase 0 — provider research
Phase 1 — core domain
Phase 2 — persistence
Phase 3 — scheduler
Phase 4 — first provider
Phase 5 — second provider
Phase 6 — API/UI
Phase 7 — metrics
Phase 8 — container hardening
Phase 9 — documentation/skills
Phase 10 — acceptance
```

Mas reorganize se houver ordem melhor.

Para cada fase forneça:

- objetivo;
- arquivos/componentes;
- dependências;
- implementação;
- testes;
- critérios de aceite;
- riscos.

---

# 39. Vertical slices

Prefira chegar cedo a um vertical slice funcional.

Exemplo:

```text
FakeProvider
    ↓
scheduler
    ↓
SQLite
    ↓
API
    ↓
simple page
    ↓
Docker
```

antes de implementar toda a complexidade dos dois providers.

Explique a sequência ideal.

---

# 40. Issues implementáveis

Ao final transforme o plano em um backlog semelhante a GitHub Issues.

Cada issue deve ter:

```text
Title
Context
Scope
Files/components
Implementation notes
Acceptance criteria
Tests
Dependencies
```

Issues devem ser pequenas o suficiente para um agente trabalhar individualmente.

Identifique quais podem ocorrer em paralelo.

---

# 41. Definition of Done

Defina DoD global.

Exemplo de expectativa:

```text
docker compose up -d
```

deve resultar em:

- serviço healthy;
- DB inicializado;
- UI acessível;
- fake provider funcional;
- provider real configurável;
- dados persistindo entre restarts;
- `/metrics` funcionando;
- scheduler explicável;
- testes passando;
- nenhuma credencial dentro da imagem;
- documentação suficiente para um novo agente trabalhar.

Refine isso.

---

# 42. Decisões que quero explicitamente respondidas

O plano final DEVE responder:

1. Qual stack você escolheu e por quê?
2. Um processo ou múltiplos?
3. SQLite ou outra solução?
4. Como representar uma window?
5. Como representar informação estimada vs observada?
6. Como funciona a máquina de estados?
7. Como funciona o scheduler?
8. O que exatamente significa `trigger` para cada provider?
9. Como impedir triggers duplicados?
10. Como persistir jobs/intenções?
11. Como recuperar estado depois de restart?
12. Como tratar trigger perdido durante downtime?
13. Como tratar timezone/DST?
14. Como as credenciais chegam ao container?
15. Como atualizar credenciais?
16. Quais APIs dos providers são oficiais?
17. Quais dependem de comportamento interno?
18. Como detectar que algo mudou?
19. Como testar sem consumir quota?
20. Qual será a interface de um provider adapter?
21. Como adicionar um terceiro provider?
22. Quais métricas serão expostas?
23. Quais dados históricos serão guardados?
24. Qual política de retenção?
25. Como funciona a configuração pela UI?
26. Config de arquivo e config de UI coexistem?
27. Qual delas tem autoridade?
28. Qual threat model?
29. Quais skills devem existir?
30. O que entra e o que NÃO entra no MVP?

---

# 43. Não faça overengineering

Questione qualquer proposta que introduza:

- Kubernetes;
- Kafka;
- Redis;
- Postgres;
- message broker;
- distributed locks;
- microservices;
- event sourcing completo;
- CQRS;
- GraphQL;
- service mesh;
- React + enorme SPA sem necessidade;
- ML;
- LLM dentro do produto.

Eles não são proibidos abstratamente.

Mas para este projeto provavelmente estão errados.

Se usar algum, justifique fortemente.

---

# 44. Qualidade esperada do plano

Não quero um documento genérico dizendo:

> “Use Docker, crie uma API e adicione testes.”

Quero decisões concretas.

Prefiro:

```text
SQLite em /data/window-manager.db

WAL habilitado.

events é append-only.
provider_state representa último snapshot conhecido.

UTC no banco.
Timezone IANA somente na camada de apresentação/scheduling.

Clock injetável no scheduler.

Scheduler roda reconcile a cada N segundos em vez de persistir timers frágeis.
```

Se essas forem as decisões corretas.

Quero esse nível de precisão.

---

# 45. Pesquisa antes da arquitetura

A sequência de trabalho obrigatória é:

```text
1. Inspecionar meus repositórios pelo GitHub connector
2. Identificar meus padrões de desenvolvimento
3. Pesquisar Codex
4. Pesquisar Antigravity
5. Mapear limitações e capabilities
6. Definir domínio
7. Comparar arquiteturas
8. Escolher arquitetura
9. Projetar MVP
10. Elaborar plano
11. Elaborar backlog
12. Elaborar estratégia de agent skills
```

Não pule diretamente para a escolha de linguagem.

---

# 46. Se encontrar incerteza

Não invente.

Marque explicitamente:

```text
UNKNOWN
```

e proponha um spike técnico.

Por exemplo:

```text
SPIKE-001
Determine whether Antigravity exposes a stable reset timestamp.

Success:
- documented API found
OR
- confirmed unavailable and adapter designed around inference
```

Transforme incertezas relevantes em spikes executáveis.

---

# 47. Output final obrigatório

Entregue o resultado nesta ordem:

## A. Executive summary

Máximo de ~1 página.

## B. Repository/workflow reconnaissance

O que encontrou nos meus projetos.

## C. Provider research

Codex e Antigravity, com:

```text
Supported
Observed
Inferred
Unknown
Risk
```

## D. Product boundaries

Incluindo explicitamente o que NÃO será construído.

## E. Requirements

Functional + non-functional.

## F. Architecture alternatives

Pelo menos duas opções reais.

## G. Architecture decision

Stack e rationale.

## H. Domain model

Entidades, states e invariants.

## I. Provider adapter design

Interface concreta/pseudocódigo.

## J. Scheduler design

Algoritmo, reconciler e failure handling.

## K. Persistence

Schema inicial concreto.

## L. Configuration model

Com precedência explícita.

## M. Credentials/security

Threat model incluído.

## N. API

Endpoints finais do MVP.

## O. Web UI

Telas/componentes e fluxo.

## P. Metrics + statistics

Inclua métricas Prometheus propostas.

## Q. Docker/deployment

Inclua topologia e hardening.

## R. Repository layout

Árvore completa.

## S. Testing strategy

Unit, integration, provider contract e E2E.

## T. Agent workflow

`AGENTS.md`, skills e instruções específicas.

## U. ADR list

Somente decisões relevantes.

## V. Implementation roadmap

Fases completas.

## W. GitHub-style backlog

Issues implementáveis.

## X. MVP Definition of Done

Checklist objetiva.

## Y. Risks / unknowns / spikes

Prioridade e mitigação.

## Z. Future work

Somente ideias naturais que NÃO devem contaminar o MVP.

---

# 48. Princípio norteador

Sempre que houver dúvida entre:

```text
mais genérico / mais sofisticado
```

e

```text
menor / explícito / previsível
```

prefira a segunda opção.

O melhor resultado deste projeto deve parecer algo como:

> “um daemon self-hosted extremamente confiável que conhece muito bem janelas de quota”

e não:

> “uma plataforma genérica de gerenciamento de IA”.

Faça a pesquisa necessária, use o GitHub connector extensivamente e produza um plano suficientemente preciso para que outro agente possa posteriormente implementar o MVP quase mecanicamente.
