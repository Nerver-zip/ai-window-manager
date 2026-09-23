# Usage — gráficos e intensidade diária de uso

Status: implementado e validado em 2026-09-23.

Data: 2026-09-23.

## 1. Resultado esperado e escopo

Adicionar **Usage** à navegação, em `/usage`, como o lugar para entender a evolução do uso e a intensidade diária de consumo. Transferir os gráficos existentes de History para Usage. History continua disponível para eventos, filtros e paginação; Overview continua mostrando o estado atual.

Adicionar um heatmap de calendário, inspirado na organização do GitHub, que represente o **consumo observado da cota semanal por dia**, preservando o histórico quando essa cota reseta. Não copiar a identidade visual do GitHub: usar os tokens, tipografia, superfícies escuras e acento azul existentes.

Este trabalho cobre uma fatia de agregação do STATS-001, não suas recomendações de horários. Não marcar STATS-001 inteiro como concluído sem separar o escopo restante.

Fora do escopo: novos providers, autenticação, triggers, alterações nas políticas do scheduler, recomendações, tokens/custos monetários, exportação, comparações entre contas, SPA, novos serviços e uma plataforma genérica de analytics. Não executar ações reais ou consumir quota para validar este trabalho.

## 2. Auditoria da implementação atual

Referências verificadas nesta preparação:

- `src/web/ui/layout.ts`: shell SSR compartilhado; navegação Overview, Schedule, History e Settings.
- `src/web/history-ui.ts`: mistura timeline e gráficos; períodos individuais `1h/3h/6h/12h/24h/7d/30d`, preservados por `chartRange` na URL. Limite de 96 pontos por série.
- `src/web/server.ts`: `/history` busca os últimos `MAX_USAGE_POINTS * 8` samples por provider antes da seleção de janela/período. Isso não garante cobertura temporal de 30 dias nem distribuição justa entre janelas.
- `src/web/ui/charts.ts`: SVG, gaps para valores nulos, tooltips e pontos acessíveis. O eixo X usa posição por índice, não distância temporal real; amostragem irregular pode aparentar regularidade inexistente.
- `src/web/ui/styles.ts` e `chart-interactions.ts`: tokens compartilhados, dark UI e progressive enhancement; aproveitar, não substituir por outro framework.
- `src/storage/repositories.ts`: samples mantêm uso, duração, reset e evidências. Existe ID SQLite autoincremental, mas a leitura pública atual retorna snapshots sem esse ID.
- `docs/persistence.md` e `src/storage/retention.ts`: samples detalhados expiram após 90 dias. Um calendário anual não pode depender apenas deles.
- `src/web/settings-api.ts`: timezone IANA persistido em SQLite; não criar outra configuração concorrente.
- `src/providers/visibility.ts`: ocultação de FakeProvider precisa valer também em Usage e nas novas consultas.

O working tree já contém mudanças anteriores. Na execução, verificar novamente status/diff e preservar alterações paralelas, especialmente assets/logos, períodos dos gráficos e visibilidade do FakeProvider.

## 3. Critérios observáveis de aceite

1. Usage aparece na navegação desktop/mobile e concentra todos os gráficos históricos.
2. History mantém eventos paginados e não duplica gráficos.
3. Cada gráfico mantém período independente, inclusive após refresh e navegação voltar/avançar.
4. Consultas e eixo temporal representam todo o intervalo escolhido, não só as últimas 96 observações.
5. O heatmap diferencia ausência de dados, ausência de aumento observado e dados parciais.
6. Reset semanal não subtrai consumo histórico nem adiciona automaticamente o saldo restante da semana anterior.
7. Replay, reinício e duplicação de amostras não contam consumo duas vezes.
8. Dias seguem a timezone salva, inclusive DST; mudar timezone não perde nem duplica o total derivado.
9. Heatmap continua disponível depois da retenção de samples detalhados.
10. HTTP lê dados persistidos; não chama provider, não dispara turno e não reconstrói todo o histórico durante uma requisição.
11. FakeProvider oculto continua ausente de seletores, gráficos, heatmap e APIs.
12. Gates permanentes passam; interface é inspecionada visualmente em 375, 768, 1440 e 1920 px, com teclado e zoom de 200%.

## 4. Organização da página e interação

Navegação: **Overview → Usage → Schedule → History → Settings**.

Composição de Usage:

1. Título `Usage`, descrição curta e timezone legível, com link para Settings.
2. Seletor de provider; quando houver apenas um, mostrar seu nome sem seletor redundante. Não somar percentuais de providers diferentes.
3. Seção `Daily usage`: heatmap e seletor de janela semanal quando houver mais de um bucket elegível. Com um bucket, mostrar `Weekly allowance`.
4. Detalhe do dia selecionado: data, quantidade observada, qualidade/cobertura e explicação de lacunas ou reset. Não depender de hover.
5. Seção `Usage over time`: gráficos por janela, por exemplo `5-hour window` e `Weekly window`, cada um com seu seletor de período.

Não adicionar uma fileira de KPIs decorativos. O calendário e os gráficos são a informação principal. Labels de produto em inglês, sem enums, IDs internos ou nomes de backlog. Reutilizar os formatadores de apresentação existentes.

### Heatmap

- Últimos 365 dias locais incluindo hoje; primeira/última semana podem ser parciais. Semana começa na segunda-feira; meses e dias da semana identificados.
- Sete linhas por semana, colunas cronológicas. Datas fora do intervalo não representam zero.
- Paleta sequencial com quatro intensidades positivas do acento existente. Escala fixa e comparável: `0`, `(0, 5]`, `(5, 15]`, `(15, 30]`, `>30` pontos percentuais da cota semanal por dia.
- `No data` tem tratamento distinto de zero; `Partial data` usa marcador adicional e explicação, não só cor. Hoje sempre é `Today · In progress`.
- Legenda explicita a unidade; tooltip/detalhe: `Approximately 12% of your weekly allowance used`, seguido de `Based on saved observations`.
- Zero significa `No increase observed`, não prova de ausência absoluta de uso. Percentuais reportados podem ser arredondados pelo provider.
- Nenhum total diário é limitado artificialmente a 100%; um dia pode atravessar um reset. Não apresentar esse total como o gauge atual de uma única semana.
- Sem janela semanal identificável: explicar `Daily activity requires weekly usage information`; manter os gráficos disponíveis. Nunca usar a janela de 5 horas silenciosamente como substituta.

### Responsividade e acessibilidade

- Desktop: calendário anual compacto; gráficos em duas colunas apenas quando houver largura útil suficiente.
- Tablet: controles quebram naturalmente; gráficos em coluna quando necessário.
- Mobile: calendário em região de rolagem horizontal contida, inicialmente na parte recente, sem overflow da página; oferecer visão alternativa de lista de dias com controles de 44 px. Não encolher 365 células até ficarem ilegíveis.
- Heatmap com foco roving e setas, Enter/Espaço seleciona dia, Escape fecha tooltip. Uma entrada na ordem de Tab, não 365. Lista alternativa funciona sem JavaScript.
- Detalhe selecionado acessível via teclado/toque e disponível em SSR por query `day`; tooltip é complementar. Sem depender apenas de `title`.
- Foco visível, status não comunicado só por cor, contraste verificado, reduced-motion respeitado e labels explícitas para cada seletor.
- Loading de reconstrução é estado real (`Preparing usage history`), com progresso limitado a dados disponíveis; não inventar skeleton permanente em página SSR. Erro mantém shell/filtros e oferece recarregar; dados antigos exibem quando foram atualizados.

## 5. Contrato do cálculo: não confundir estoque e consumo

`usageRatio` é o percentual acumulado de uma janela, não o consumo daquele dia. O heatmap deriva aumentos ao longo das observações. Unidade interna: pontos percentuais da cota semanal, com precisão mantida até a formatação.

Não converter em tokens, mensagens ou dinheiro. Não somar o mesmo uso observado na janela de 5 horas e na semanal. Cada combinação provider + windowKind é independente. Identificar elegibilidade semanal por duração normalizada confiável de 604800 segundos; nome `secondary` ou texto do label não é prova. Se duração estiver ausente, usar apenas metadado anterior confiável e não contradito daquele bucket, registrando a origem; caso contrário, indisponível.

Somente fatos válidos, frescos na ocasião da observação e de confiança `exact/high` alimentam o cálculo. Fato ausente, repetido com timestamp de evidência antigo, incompatível ou de baixa confiança abre lacuna; não vira zero. A atualização da página não torna um fato mais fresco.

### Estado por série e transição pura

Implementar uma função pura que recebe estado anterior e sample identificado e retorna novo estado + contribuição/qualidade. Estado mínimo: último ID processado, timestamp aceito, bucket/época, reset confiável, duração, high-water de uso, último sample aceito e versão do algoritmo.

Regras da versão inicial:

1. Primeiro sample é baseline; não atribuir todo o acumulado ao dia da instalação. História anterior é desconhecida.
2. No mesmo ciclo, contribuição é `max(0, currentUsage - highWater)`; atualizar high-water apenas para cima. Isso evita que `40 → 35 → 40` gere 5 pontos fictícios. Uma correção torna o intervalo parcial; não alegar que essa regra recupera consumo real oculto pela correção.
3. Não classificar qualquer queda como reset. Um reset precisa de evidência temporal coerente: limite anterior confiável atravessado, novo limite coerente e fatos compatíveis do mesmo bucket. Reset projetado que muda a cada polling não define novos ciclos. Usar confirmação por observações consistentes quando a fronteira não for demonstrável; persistir candidato sem contar repetidamente.
4. Em transição demonstrável, preservar todas as contribuições anteriores. O percentual observado do ciclo novo pode entrar uma única vez como contribuição desde a fronteira conhecida até o sample. Nunca inferir que a semana anterior chegou a 100%.
5. Se a fronteira não for localizável, ou duração/plano mudar, iniciar nova baseline e marcar descontinuidade. Não fabricar consumo para fechar uma conta. Dados retrospectivos já computados não são apagados.
6. Ausência de resetAt ainda permite deltas entre amostras coerentes próximas; queda sem fronteira confiável permanece ambígua. Não contar rebote abaixo do high-water. A continuidade deve ser invalidada se não for possível excluir reset no intervalo.
7. Intervalos atravessando ciclos não observados são parciais; não inventar semanas intermediárias. Distinguir delta conhecido de atribuição diária desconhecida.
8. Samples idênticos não geram contribuições novas; mesmo timestamp com valores conflitantes é dado ambíguo. ID novo com timestamp anterior ao último aceito é atrasado: marcar e não aplicá-lo sobre o presente. Correção retroativa só por replay determinístico do segmento com substituição transacional, nunca soma aditiva.
9. Mudança de conta por fora da aplicação pode ser indetectável no contrato atual. Não introduzir leitura de credenciais para detectá-la; documentar essa limitação e segmentar quando houver incompatibilidade observável.

Antes de persistir o algoritmo, formalizar os predicados de continuidade/reset em tabela de transições e fixtures. Se o contrato normalizado não comprovar uma fronteira, escolher `partial/unknown`, não uma heurística silenciosa que prometa exatidão.

### Atribuição a dias

- UTC para intervalos persistidos; datas civis na timezone IANA salva na leitura.
- Intervalos curtos contínuos: distribuir o delta proporcionalmente aos segundos reais de interseção com cada dia. É uma estimativa temporal explícita, não horário exato de cada mensagem.
- Limite inicial de interpolação: 15 minutos. Polling maior continua permitido, mas não ganha falsa precisão diária; manter esse limite como constante documentada/testada, sem nova tela de configuração nesta fase.
- Para lacunas maiores: se toda a contribuição seguramente pertence a um único dia, exibir o observado com qualidade parcial. Se atravessa dias e não há atribuição defensável, conservar como não atribuído e não colorir arbitrariamente esses dias; mostrar aviso/quantidade não atribuída quando conhecida.
- Em reset, o trecho do ciclo anterior sem observação final é desconhecido; a contribuição nova pertence somente ao intervalo pós-reset demonstrável.
- Ausência de observações após o último sample não prova zero até meia-noite. Dia atual é parcial; cobertura mede tempo observado, não acurácia do provider.
- Não usar dias de 86400000 ms para fronteiras locais. Reutilizar as funções IANA existentes quando adequadas e testar dias de 23/25 horas, meia-noite inexistente e offsets fracionários.

### Exemplos obrigatórios

| Observações                                  | Resultado esperado                                                 |
| -------------------------------------------- | ------------------------------------------------------------------ |
| Mesmo ciclo: 20 → 25 → 31                    | 11 pontos observados, não 31                                       |
| Primeiro sample: 69                          | Baseline; passado desconhecido                                     |
| Mesmo ciclo: 40 → 35 → 40 → 43               | 3 pontos; correção sinalizada                                      |
| Ciclo A: 90 → 95; reset comprovado; B: 2 → 6 | 11 pontos observados; nenhum -93 ou +5 imaginário para completar A |
| Reset móvel, uso constante 0                 | Nenhuma nova contribuição; não criar ciclo por polling             |
| Reset potencial sem evidência                | Parcial/desconhecido; nenhuma subtração histórica                  |
| Delta 4 entre 23:58 e 00:02 em dia normal    | Aproximadamente 2 por dia; soma preservada                         |
| Lacuna de dois dias e delta não localizável  | Dias parciais; contribuição não atribuída, não dois zeros          |
| Replay/reabertura do DB                      | Mesmas contribuições e totais                                      |

## 6. Persistência, retenção e processamento

Adicionar migration forward-only numerada após a última existente na execução. Não editar migrations publicadas.

Implementação entregue, sem plataforma genérica de eventos:

- `usage_aggregation_checkpoint`: cursor global de sample SQLite processado, atualizado atomicamente com o lote.
- `usage_series_state`: baseline/high-water, último sample aceito, duração/reset confiáveis e versão do algoritmo por provider/window.
- `usage_intervals`: um registro por sample que produz intervalo, com delta nullable quando desconhecido, qualidade e reason code limitado. `source_sample_id` como chave primária torna replay idempotente; intervalos de cobertura sem aumento também são preservados.
- Evitar tabela de totais diários como única fonte: ela perderia a capacidade de redividir dias após alteração de timezone. Começar projetando intervalos por dia com consultas limitadas; adicionar cache diário somente se medição demonstrar necessidade, com timezone e versão na chave.

IDs de origem são referências de auditoria, não FKs com cascade que apaguem agregados quando samples expiram. Guardar nos intervalos os fatos derivados necessários; nunca payload bruto ou identificadores pessoais.

Processamento incremental após persistência de observação, em serviço pequeno e separado do scheduler. Usar os IDs já existentes e cursor de ingestão, sem depender só de timestamp. Gravar intervalo e checkpoint na mesma transação. Backfill histórico ordenado deterministicamente por tempo/ID até um watermark capturado; depois processar ingestão nova por ID, tratando atrasos explicitamente. Não segurar transação durante provider I/O.

O serviço não deve bloquear inspeções/ações com reconstrução longa. Backfill em lotes (inicialmente 500 samples), ceder execução entre lotes, impedir sobreposição e persistir progresso. Recuperar no próximo startup. Endpoint só lê progresso/dados já materializados.

Retenção: manter samples detalhados em 90 dias e intervalos derivados por 400 dias, suficientes para 365 dias locais mais margens. O checkpoint protege samples ainda não processados; o estado de série permanece para manter a baseline do ciclo aberto.

Somente histórico ainda disponível pode ser reconstruído. Dias antigos já removidos são `No data`. Atualização futura do algoritmo só reprocessa período com evidência suficiente; não prometer reconstrução exata de dados brutos já expirados. Manter versão nos resultados e documentar limitações de correção.

Medir volume de intervalos com polling de 30s, armazenamento e tempo de consulta em fixture anual. Se necessário, compactar intervalos equivalentes com preservação de quantidade/cobertura e regra explícita de resolução temporal; não introduzir infraestrutura OLAP.

## 7. Leitura, gráficos e compatibilidade

Criar um serviço de leitura compartilhado pelo SSR e GET `/api/v1/usage`. A resposta é limitada a 365 dias de calendário e séries filtradas pelo intervalo individual selecionado.

Contrato sugerido: provider/bucket, timezone efetiva, intervalo, `asOf`, estado de processamento; calendário com `localDate`, `observedPercentagePoints`, `unattributedPercentagePoints` quando aplicável, qualidade, cobertura e motivos limitados. Não chamar valores derivados de `exact`. Query validada; no máximo 365 dias de calendário e 30 dias por gráfico; limitar quantidade de seletores e série. Provider invisível segue a política atual de 404/vazio, sem vazamento em contagens.

Gráficos:

- Consulta indexada por provider + windowKind + tempo e amostragem reduzida cobrindo **todo** o intervalo.
- Não reutilizar `slice(-96)` como downsampling. Adotar buckets temporais e preservar primeiro/último, extremos, resets e gaps dentro de orçamento documentado (por exemplo até 384 pontos por gráfico). Se orçamento exigir sumarização adicional, sinalizá-la; não ligar lacunas como observações contínuas.
- Eixo X proporcional a timestamp e domínio do período selecionado, compartilhado por séries do mesmo gráfico. Labels na timezone efetiva, explicitada na página/tooltips.
- Reset quebra a continuidade visual ou recebe marcador claro; não desenhar queda como consumo negativo diário.
- Heatmap usa dados completos de agregação, nunca pontos reduzidos para desenho.
- Preservar seletores individuais de 1h a 30d em query, com formulários GET funcionais sem JS e melhoria progressiva opcional.
- `/history` continua acessível com seus filtros/paginação. URLs com `chartRange` exibem um link para Usage, transferindo seleções válidas sem redirecionar a timeline.
- Overview pode incluir link discreto `View usage`; não duplicar calendário nem redesenhar Settings/Schedule.

## 8. Arquivos e fases de execução

Os caminhos novos abaixo são sugestões; confirmar convenções antes de criar arquivos. Root mantém integração e documentos; se houver subagents, separar ownership de domínio/storage e renderização, após estabilizar contratos.

### Fase A — contrato e testes do cálculo

Criar `src/usage/` para tipos, transições puras e divisão de dias; `tests/usage/` com fixtures sintéticas. Definir reset/continuidade/qualidade antes da UI. Reutilizar Clock e utilitários IANA, sem espalhar relógio real.

Entrega: tabela de transições provada, exemplos numéricos e invariantes de conservação/idempotência. Nenhuma mudança de provider necessária.

### Fase B — armazenamento e integração incremental

Migration nova, repository dedicado, leitura de samples com IDs, serviço de agregação, pequeno wiring em `src/index.ts`/ponto de observação persistida e retenção. Testar instalação nova, upgrade, backfill, crash/restart e expiração de samples.

Entrega: calendário consultável de forma limitada e persistente, sem reconstrução no GET.

### Fase C — Usage e transferência dos gráficos

Criar `src/web/usage-ui.ts` e serviço de leitura; ajustar `server.ts`, `ui/layout.ts`, `history-ui.ts`, `ui/charts.ts`, `ui/chart-interactions.ts`, `ui/styles.ts`. Consolidar constantes/controles compartilhados em vez de duplicar History com outro nome. Corrigir domínio temporal e consultas junto à transferência.

Entrega: rota/menu, períodos independentes, History só com eventos e compatibilidade dos links.

### Fase D — heatmap e acabamento

Primitiva de calendário, legenda, seleção do dia, estados, lista acessível, mobile e metadados de qualidade. Usar fixtures densas/esparsas e com resets para inspeção visual. Não alterar logos/assets paralelos.

### Fase E — validação e documentação

Atualizar README, docs/ui.md, docs/persistence.md, docs/api.md, docs/testing.md e backlog/plano apenas no que foi entregue; registrar a decisão de intervalos/retention que revisa a antiga restrição de ausência de agregação. ADR curto se necessário para a política durável de estatísticas.

Slices sugeridas para revisão: cálculo; persistência/backfill; página/gráficos; heatmap/acessibilidade; documentação final. Não fazer commits, push ou reiniciar o runtime autenticado sem pedido explícito da execução. Não incluir diffs anteriores inadvertidamente.

## 9. Matriz de testes e validação

### Unidade e integração

- Todos os exemplos da seção 5; múltiplos resets no intervalo; reset perto de meia-noite; reset atravessado sem queda percentual; resetAt ausente/móvel; duração alterada; baixa confiança; percentuais nulos/inválidos; baseline de instalação.
- Duplica sample com ID diferente; repete ID; timestamps iguais conflitantes; atrasos; clock regressivo; timeout de inspeção sem sample novo; não somar 5h e semanal nem buckets distintos.
- Midnight/DST de primavera e outono, America/Sao_Paulo, offset fracionário, ano bissexto; troca de timezone preserva soma atribuída + não atribuída.
- Migração do DB anterior e DB vazio, execução duas vezes, transação interrompida, checkpoint retomado, watermark durante novas inserções, retenção após 90 dias e agregados após reabrir SQLite.
- Teste de conservação: soma de contribuições = soma de dias + não atribuídos, dentro de tolerância numérica; sem arredondamento por sample. Reprocessamento mantém resultado.
- `/usage` e APIs funcionam com spy que lança se inspect/trigger for chamado. FakeProvider escondido não aparece. Payloads escapados, queries limitadas, CSP preservada.
- Período de um gráfico não altera outro nem calendário. Volume de 30 dias continua cobrindo o início/fim. Samples irregulares têm distância temporal proporcional. Lacunas permanecem lacunas.
- History mantém 20 eventos/página, filtros e navegação; Overview, Schedule e Settings não regridem.
- Calendar vazio, zero observado, parcial, dia atual, provider pausado, indisponível e sem janela semanal; teclado/toque/lista sem JS.

### Gates reais na implementação

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm secret:scan
pnpm validate
docker compose config --quiet
docker build -t ai-window-manager:usage .
```

Executar smoke documentado em ambiente descartável com FakeProvider, sem credenciais, porta/volume próprios: startup, `/healthz`, `/usage`, `/history`, API, agregação, restart, shutdown e persistência. Não substituir o runtime Codex do usuário para uma validação visual.

Manter >=90% em statements/branches/functions/lines, sem excluir código relevante. Medir consultas com `EXPLAIN QUERY PLAN`, contagem de linhas e fixture de 365 dias; não usar threshold de wall time frágil como único teste. Registrar latência/tamanho obtidos e garantir trabalho limitado por lote/request.

Inspeção visual real em 375/768/1440/1920 px: calendário, tooltips, controles, empty/error/partial, overflow, foco, zoom, contraste e navegação. Capturar evidências; compilar não substitui inspeção renderizada.

## 10. Riscos e decisões explícitas

- Snapshots percentuais não são medidor exato de consumo; arredondamento, plano alterado e períodos offline limitam reconstrução. O produto deve dizer isso claramente.
- Um reset não invalida o consumo já observado, mas a falta de observação imediatamente antes dele pode deixar consumo desconhecido. Não prometer recuperar esse valor.
- Calendário anual ficará inicialmente incompleto se só houver poucos dias/90 dias de histórico. Preenchimento melhora prospectivamente, não por dados sintéticos.
- Preservar intervalos custa mais armazenamento que totais diários, mas permite timezone correta sem reter todos os samples originais. Medir e compactar somente sem falsear precisão.
- Não usar autenticação, leitura de secrets ou chamadas novas para suprir falta de informação. Se a semântica não puder ser provada, reduzir confiança/mostrar indisponível.

## 11. Resultado da execução

- Menu e rota `/usage` implementados; os gráficos foram movidos de History e cada janela conserva seu período individual. History permanece dedicado a eventos paginados.
- A agregação semanal é incremental e persistida. Consumo é derivado de diferenças positivas entre observações confiáveis; reinício da janela só inicia um novo ciclo quando a fronteira anterior e a nova fronteira são observadas. Correções, gaps e resets ambíguos permanecem parciais ou desconhecidos, sem fabricar consumo.
- A página e `/api/v1/usage` leem estado persistido. O GET não inspeciona providers. O heatmap mostra 365 dias, timezone local, seleção/detalhe do dia, níveis de intensidade, dados parciais/desconhecidos e alternativa em lista.
- A inspeção renderizada encontrou e corrigiu uma falha de CSP: um `style` inline definia as colunas e era corretamente bloqueado por `style-src 'self'`. O calendário agora usa layout flexível sem afrouxar CSP.
- Inspeção Chrome feita em 375×900, 768×1000, 1365×1000 e 1920×1080. Em larguras estreitas, o calendário mantém células legíveis em uma faixa com rolagem horizontal própria.
- `pnpm validate` passou: 40 arquivos / 483 testes; statements 96.03%, branches 90.23%, functions 97.21%, lines 96.03%; Gitleaks sem findings.
- `docker compose config --quiet` e `docker build -t ai-window-manager:usage-validation-20260923 .` passaram. Um Compose descartável, separado do runtime em `8878`, respondeu healthy e HTTP 200 em `/`, `/healthz`, `/metrics`, `/usage`, `/history`, `/api/v1/usage` e `/api/v1/providers`. Uma fixture sintética de 365 dias produziu 365 dias agregados; após `docker compose restart`, o serviço voltou healthy e os dados permaneceram legíveis. Codex ficou desativado e nenhuma ação de provider foi executada.
- Migração `004_usage_aggregation.sql` adiciona checkpoint, estado por série e intervalos derivados; a retenção conserva agregados por 400 dias enquanto samples brutos permanecem limitados a 90 dias.

Limitações restantes: os valores são estimativas dos deltas observados, não medição exata do consumo. Gaps longos, arredondamento do provider, correções de contador e resets sem observação suficiente podem deixar dias parciais/desconhecidos. A página não recupera uso anterior à primeira amostra confiável. A entrega cobre agregação histórica do STATS-001, não o item completo de estatísticas/recomendações.

## 12. Formato do relatório da execução

Informar arquivos e migração; cálculo adotado e limitações; exemplos de reset e meia-noite com resultados; replay/restart/retention; cobertura real; comandos com resultados reais; screenshots/viewports; impacto API/config/DB; riscos restantes. Diferenciar planejado, implementado, testado e validado visualmente. Não declarar STATS-001 inteiro concluído nem sugerir que foi gasto quota para produzir o heatmap.
