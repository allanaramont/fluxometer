# Fluxometer — design

## Intent e por quê

Allan trabalha em vários apps JS/TS + Postgres (agriness, 3clicksrh, pessoal) e,
hoje, toda vez que precisa de observability de performance/custo, repensa a
solução do zero. Fluxometer existe pra eliminar esse retrabalho: uma lib
pública que qualquer projeto JS/TS com Postgres instala, e já sai com
coleta de métrica, resumo diário no Slack com os gargalos priorizados, e um
servidor MCP pra perguntar "o que devo olhar hoje" direto pra IA.

Nasce como lib pública desde o dia 1 — não como código específico do Fluxo
Casa que depois é extraído. O Fluxo Casa é só o primeiro app que instala.

Valor central: custo zero (sem SaaS pago, sem infra nova, sem conta em
terceiro), zero config alem de um comando de CLI, zero dashboard pra
construir ou proteger.

## Goals (v1)

- Pacote npm `fluxometer`, JS/TS only, armazenamento só em Postgres (o que
  o app já tem).
- `npx fluxometer init`: cria schema isolado `fluxometer` no Postgres (SQL
  idempotente, não interfere com migration tool do app — Prisma/Drizzle/
  TypeORM nem percebem), pergunta a URL do webhook do Slack, escreve no
  `.env`, e gera um workflow do GitHub Actions pronto (`schedule:`) que
  dispara o resumo diário batendo numa rota exposta pelo pacote. Gera
  também um template de Vercel Cron como alternativa.
- Adapters oficiais: Express, Fastify, Next.js (middleware). `track()`
  genérico pra qualquer outro framework JS/TS.
- Coleta é fire-and-forget / em lote — nunca bloqueia a resposta, nunca
  abre pool de conexão próprio sem controle (aprendizado direto de
  incidente real de pool do Supabase no Fluxo Casa — ver
  `project-fluxo-casa-home-summary-and-connection-pool` em memory).
- Tabelas: `request_metrics` (rota normalizada, método, status, duração,
  `user_hash`, platform), `client_metrics` (tela, ação, duração — opcional,
  só quem quiser reportar client-side), `ai_calls` (modelo, duração,
  tokens, custo, sucesso, `user_hash`). `pg_stat_statements` é lido direto
  do Postgres, sem tabela própria.
- Privacidade: nunca grava PII (nome, e-mail, texto digitado, id real na
  rota) — só `user_hash` e rota normalizada. Limpeza diária apaga linhas
  com mais de 30 dias (mesmo cron do resumo).
- Motor de regras fixo e determinístico (sem chamada de IA, custo zero),
  cobrindo os sintomas abaixo, cada um com causa provável + sugestão:
  1. Rota lenta (p95 > limiar com volume mínimo)
  2. Regressão vs. semana anterior (p95 subiu > X%)
  3. Maior consumidora (top N por tempo total)
  4. Erro em alta (taxa de 5xx acima do limiar numa janela curta)
  5. Consulta lenta (`pg_stat_statements` acima do limiar)
  6. Alta variância p99/p50 (indício de cold start/lock, não problema
     constante)
  7. Erro concentrado numa plataforma só (ios vs web vs android)
  8. Timeout/5xx concentrado (função batendo limite de tempo)
  9. Custo de IA subiu sem subir volume de chamadas (prompt mais longo ou
     perda de cache)
  10. Taxa de falha de IA alta (`success=false` acima do limiar)
  11. Gargalo concentrado num horário de pico (falta de autoscaling)
  12. Rota lenta que ficou lenta logo após deploy recente (regressão
      pós-deploy)
  - Lista fechada no v1 — sem API de regra customizada pelo usuário.
- Esse motor é fonte única, consumida por duas saídas:
  - **Slack**: um único resumo diário (lista ranqueada com causa+sugestão,
    cobrindo todas as ~12 regras, incluindo erro em alta e custo de IA)
    via webhook, sem OAuth. Um cron só, 1x por dia — sem segundo cron
    "imediato" (decisão explícita: evitar qualquer custo/complexidade de
    agendamento extra na implantação). O contrato real é só "1 chamada
    HTTP autenticada por dia na rota que o pacote expõe" — GitHub Actions
    e Vercel Cron são só 2 geradores de conveniência em cima desse mesmo
    contrato; crontab simples com `curl` funciona igual, em qualquer
    servidor, sem depender de nenhuma plataforma específica.
  - **MCP** (`npx fluxometer mcp`, stdio, local): ferramentas read-only
    sobre o mesmo cálculo (ex. `whatShouldILookAtToday()`), pra qualquer
    cliente MCP (Claude Desktop/Code, Cursor etc.) responder "o que tá
    pegando hoje" já com a resposta priorizada e a sugestão — sem
    dashboard, sem rota exposta na internet, sem superfície de auth pra
    proteger.
- i18n: textos de cada regra vêm de um catálogo central (mesmo padrão já
  validado no Fluxo Casa com 8 idiomas), suportando no mínimo `en`, `es`,
  `pt`, selecionado via `FLUXOMETER_LOCALE`. Default: `en` (público é
  global).
- Repo: novo repo GitHub `fluxometer` (conta pessoal do Allan), caminho
  local `~/Envs/desenvbr-projects/fluxometer` (irmão do `fluxo-casa`,
  seguindo a convenção já usada pros produtos indie do Allan em
  `desenvbr-projects`). Nome checado disponível no npm e no GitHub em
  2026-11-02.

## Non-goals (v1, explícitos)

- Nenhum banco além de Postgres (MySQL/SQLite/Mongo ficam de fora — a
  identidade do produto é "usa o Postgres que você já tem").
- Nenhum dashboard web hospedado/exposto por HTTP — a superfície de
  segurança (auth, sessão, rate limit) não compensa no v1; MCP + Slack
  cobrem o "ver os dados".
- Nenhum sistema de regra extensível/plugável pelo usuário — catálogo
  fechado, decisão explícita do Allan ("lib fácil de colocar e pronto").
- Nenhuma chamada de IA feita pelo próprio pacote pra gerar sugestão — todo
  texto de causa/fix é estático, vindo do catálogo i18n. A "inteligência"
  vem do assistente de IA do próprio usuário consumindo a ferramenta MCP,
  nunca de uma chamada de modelo que o pacote paga.
- Nenhum runtime fora do ecossistema Node/JS/TS.
- Nenhum processo extra que o usuário precise hospedar e pagar — os únicos
  componentes "sempre ligados" são o próprio processo do app do usuário
  (onde o adapter roda dentro) e o cron externo gratuito (GitHub
  Actions/Vercel Cron) batendo numa rota que o pacote expõe.

## Anti-goals (o que seria falha mesmo funcionando)

- Quebrar ou lentar de forma perceptível o app hospedeiro (estourar pool
  de conexão do Postgres, adicionar latência perceptível nas respostas) —
  isso é pior que não ajudar.
- Exigir criação de conta paga, API key ou cadastro em SaaS de terceiro
  pra ter a experiência central (coleta + Slack + MCP).
- Instalação que leva mais que poucos minutos ou exige escrever SQL/cron
  na mão.
- Vazar qualquer PII mesmo no pior cenário de brecha do schema
  `fluxometer`.

## Constraints

- JS/TS + Postgres only.
- Custo de infra zero — qualquer mecanismo de disparo usa tier gratuito
  que o usuário provavelmente já tem (GitHub Actions, Vercel Cron),
  gerado automaticamente pelo CLI, nunca escrito na mão.
- Escrita fire-and-forget; não pode competir pelo orçamento de conexão do
  Postgres do app hospedeiro.
- Isolamento de schema/tabela não pode interferir (nem aparecer como
  drift) na ferramenta de migration do app hospedeiro.

## Decisões já tomadas (não re-discutir)

- Stack: JS/TS only.
- Storage: Postgres-only no v1.
- Ordem de build: lib pública desde o dia 1; Fluxo Casa é o primeiro
  instalador, não um protótipo a extrair depois.
- Disparo: cron externo gratuito, auto-gerado pelo `init`, batendo numa
  rota exposta pelo pacote — nunca processo próprio hospedado.
- Cadência: **um único cron diário**, sem segundo cron "imediato" — custo
  de implantação extra foi explicitamente rejeitado. Erro em alta e custo
  de IA entram no mesmo resumo do dia, não como alerta separado.
- Dashboard: removido do v1 em favor do servidor MCP.
- Motor de regra: fixo/determinístico, sem geração de texto por IA;
  ampliado de 5 (doc original) pra ~12 sintomas.
- Extensibilidade: rejeitada no v1 — catálogo fechado.
- i18n: en/es/pt via catálogo central, default `en`.
- Nome: **fluxometer** (npm e GitHub confirmados livres em 2026-11-02).
- Repo: novo, em `~/Envs/desenvbr-projects/fluxometer`.
- Licença: MIT.
- MCP conecta direto no Postgres de produção usando uma role separada,
  só leitura, restrita ao schema `fluxometer` (`init` cria essa role
  quando tiver permissão; senão documenta o SQL pra pessoa rodar). Sem
  API/rota extra pra isso. Responsabilidade de guardar essa credencial
  com segurança (não vazar o `.env` do laptop, não reusar a role
  principal do app) é da pessoa que instala — documentado em claro no
  README/SECURITY.md, não é algo que o pacote pode garantir por código.

## Modelo de credenciais

Princípio: fluxometer não tem backend próprio, não telemetria, não "liga
pra casa" — nenhuma credencial passa por nós, tudo fica no `.env`/secrets
da própria pessoa.

| Credencial                               | Origem                                                         | Onde mora                                                                                      | Pior caso de vazamento                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `FLUXOMETER_SLACK_WEBHOOK_URL`           | Pessoa cria em Slack → Incoming Webhooks                       | `.env` do app                                                                                  | Write-only: alguém posta spam no canal. Não lê nada.                                                         |
| `DATABASE_URL` (escrita)                 | Já existe no app                                               | `.env` do app (nenhuma nova)                                                                   | Mesmo risco que o app já tem hoje — não aumenta superfície.                                                  |
| `FLUXOMETER_READONLY_URL` (leitura, MCP) | `init` cria role Postgres `SELECT`-only no schema `fluxometer` | `.env` do app + config local do cliente MCP (ex. `claude_desktop_config.json`)                 | Leitura de métrica anonimizada (sem PII) — nunca dado real do app.                                           |
| `FLUXOMETER_CRON_SECRET`                 | `init` gera string aleatória forte (32+ bytes)                 | Secret do GitHub Actions / `CRON_SECRET` nativo do Vercel / env do servidor que roda o crontab | Rota de relatório recusa (401) sem o header — comparação em tempo constante, não vulnerável a timing attack. |

## Segurança — ameaças revisadas no design

- **Supply chain (o pacote em si):** zero script de `postinstall`; o CLI só
  roda quando a pessoa chama explicitamente (`npx fluxometer init`/`mcp`).
  Dependências mínimas (`pg` + cliente HTTP nativo pro webhook, nada de
  framework pesado) — menos superfície pra auditar num pacote que vai
  rodar dentro do app de terceiros.
- **Prompt injection → SQL via MCP:** as ferramentas MCP nunca aceitam SQL
  livre ou string de busca que vá direto pra query — só parâmetros
  tipados/enum (ex. janela de tempo) sobre consultas fixas e
  parametrizadas. Fecha o vetor onde um conteúdo malicioso lido pela IA
  tentaria instruir o assistente a "rodar essa query".
- **Rota de cron:** autenticada por `FLUXOMETER_CRON_SECRET` com
  comparação em tempo constante (`crypto.timingSafeEqual`), mais um
  limite simples de execução (ignora chamadas repetidas dentro de uma
  janela curta) como defesa extra caso o segredo vaze.
- **Fire-and-forget nunca pode derrubar o app:** toda escrita de métrica
  tem `catch` que loga uma vez (nunca silencioso, nunca repetido em loop)
  e nunca propaga exceção pro código do usuário — detalhe de
  implementação, mas é anti-goal se falhar.
- **Pool de conexão do MCP/coleta:** pool próprio e pequeno (1-2 conexões),
  conexão lazy (só abre no primeiro uso real), nunca compete com o pool
  principal do app.
- **Responsabilidade do usuário final:** guardar a `FLUXOMETER_READONLY_URL`
  com cuidado (não commitar, não reusar a role de escrita) é documentado
  no README/SECURITY.md como responsabilidade de quem instala — o pacote
  reduz o blast radius (role só leitura, só schema isolado, zero PII) mas
  não controla a máquina da pessoa.

## Checklist de instalação (pra validar "fácil de usar")

1. `npm install fluxometer`
2. `npx fluxometer init` — precisa já ter `DATABASE_URL` no ambiente (se
   faltar, erro claro com instrução, nunca stack trace cru).
3. CLI pede a URL do webhook do Slack, com o link direto de onde criar.
4. CLI tenta criar a role de leitura sozinha; se não tiver permissão,
   imprime o SQL pronto pra colar no painel do provedor (ex. Supabase).
5. CLI gera `FLUXOMETER_CRON_SECRET` e tenta `gh secret set` automático se
   detectar `gh` autenticado; senão, imprime o valor pra colar manualmente.
6. CLI escreve `.github/workflows/fluxometer-report.yml` (e o template
   Vercel Cron como alternativa) — a pessoa só precisa commitar.
7. Uma linha de adapter no código do app (copiar do README).
8. Deploy.

Única etapa fora do nosso controle é criar o webhook no Slack (UI deles) —
o resto cabe nos ~5 minutos prometidos pra quem já tem Postgres + Git.

## O que fica a cargo de quem for construir

- Nome exato de colunas e redação da migration SQL (reusar o schema do
  doc original quase literal).
- Lista final e limiares de cada uma das ~12 regras (propor valores
  iniciais; Allan ajusta depois de ver linha de base real, mesmo espírito
  do doc original).
- Nomes/assinaturas exatos das ferramentas MCP e formatação markdown da
  mensagem do Slack.
- Gerar os dois templates de cron (GitHub Actions e Vercel Cron) no
  `init`, deixando o usuário manter o que fizer sentido pro deploy dele.

### Decisões já resolvidas pelo builder (revisão do design, não re-discutir)

- **Auth da rota de cron:** `init` gera um segredo (`FLUXOMETER_CRON_SECRET`),
  escreve no `.env` e no template de workflow/cron; a rota exposta pelo
  adapter exige esse header e responde 401 sem ele — mesmo padrão do
  `CRON_SECRET` da Vercel. Sem isso a rota seria invocável por qualquer um.
- **Next.js e Edge runtime:** o driver `pg` não funciona em Edge. O adapter
  Next.js força `export const runtime = 'nodejs'` explicitamente e
  documenta que não há suporte a Edge runtime nesta versão.
- **Sinal de "deploy recente" (regra 12):** lido de env vars padrão de CI/CD
  no boot do processo (`VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, ou
  `FLUXOMETER_DEPLOY_ID` como override manual) — grava um marcador de
  deploy na primeira requisição após boot; sem nenhuma dessas env vars a
  regra 12 fica inativa silenciosamente (não quebra o resto).
- **`pg_stat_statements` sem permissão (managed Postgres, ex. Supabase não-
  superuser):** `init` detecta a falha de permissão/extensão, avisa uma vez
  e desliga só a regra 5 (consulta lenta) — nunca aborta a instalação nem
  quebra o resto da coleta.

## Referência

Documento original que deu origem a este design:
`Fluxo Casa — medição de performance e alerta de gargalo no Slack.md`
(2026-11-02, mesmo autor) — cobre o pensamento original de métricas,
regras de gargalo e fases, mas era escopo "dentro do Fluxo Casa"; este
design generaliza pra lib pública instalável em qualquer app JS/TS com
Postgres.
