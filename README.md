# Agent Gateway

Transforma o **OpenCode** em um agente remoto sempre disponível, com a experiência de
comandos do Hermes Agent — direto pelo **Telegram** (e Instagram Direct quando configurado).

O OpenCode continua sendo o cérebro: agente, ferramentas, código e execução.
Este gateway é só a camada de interface remota.

```
Telegram ───────┐
                │      ┌──────────────────┐
Instagram ──────┼────► │  Agent Gateway   │
                │      │  · autorização    │      ┌──────────────┐
                │      │  · comandos "/"   │ ───► │  OpenCode    │ ───► ferramentas,
Local/CLI ──────┘      │  · sessões        │      │  (servidor   │       arquivos,
                       │  · streaming      │      │   persistente)│      PC Windows
                       └──────────────────┘      └──────────────┘
```

## Por que existe

| Problema comum em bots "chatbot" | Como este projeto resolve |
|---|---|
| Novo processo do agente por mensagem | Um único `opencode serve` persistente, supervisionado |
| Sem memória entre mensagens | Sessões persistentes mapeadas por canal + usuário |
| Lixo de terminal (`[0m`, banners) na resposta | Sanitizador outbound + redação de segredos |
| Comandos lentos que caem no LLM | CommandRegistry local — `/status` responde <300 ms sem IA |
| Ações perigosas sem freio | Níveis de segurança + tokens de confirmação de uso único |
| Usuários desconhecidos usando o bot | Default-deny por allowlist de IDs |

## Funcionalidades

- 💬 **Conversa persistente** — contexto mantido entre mensagens; `/new` abre conversa nova sem perder o projeto
- ⚡ **Streaming real** — resposta editada ao vivo (~700 ms) via SSE do servidor OpenCode
- 🧭 **31 comandos slash** inspirados no registro oficial do Hermes Agent
- 🤖 **Modos de roteamento**: `/auto` `/fast` `/code` `/deep` → modelos do seu provedor (ex.: OmniRoute)
- 📁 **Multi-projeto**: `/project` troca o workspace do agente
- 🖥️ **Controle do PC**: `/sys` `/ps` `/open` `/shot` `/url` + ações sensíveis com confirmação
- 🔒 **Segurança em camadas**: allowlist, redação de segredos, confirmação de 6 dígitos (5 min, uso único)
- 📸 **Instagram Direct** pronto via API oficial da Meta (dormante até você configurar)

## Requisitos

- Windows 10/11 (testado) — adaptável para Linux/macOS
- [Node.js 18+](https://nodejs.org)
- [OpenCode](https://opencode.ai) instalado (`npm i -g opencode-ai`)
- Um provedor de modelo configurado no OpenCode (ex.: OmniRoute, Anthropic, OpenAI…)
- Bot do Telegram criado no [@BotFather](https://t.me/BotFather)

## Instalação

```bash
git clone https://github.com/SEU-USUARIO/agent-gateway.git
cd agent-gateway
npm install
copy .env.example .env   # Linux/macOS: cp .env.example .env
```

Preencha o `.env`:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | Token do @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | ✅ | Seu ID numérico (pegue no @userinfobot). Vírgula p/ vários |
| `DEFAULT_WORKSPACE` | – | Pasta do projeto padrão do agente |
| `OPENCODE_SERVER_*` | – | URL/usuário/senha do servidor local |
| `INSTAGRAM_*` / `META_*` | – | Só se quiser Instagram Direct |

Iniciar:

```powershell
powershell -File scripts\start-agent.ps1     # background, janela oculta
powershell -File scripts\stop-agent.ps1      # parar
npm test                                     # 31 testes automatizados
```

## Comandos no Telegram

Digitar `/` abre o menu. Visão geral:

| Categoria | Comandos |
|---|---|
| **Sessão** | `/new` `/sessions` `/resume` `/title` `/retry` `/undo` `/compress` `/background` `/stop` |
| **Modelo** | `/model` `/auto` `/fast` `/code` `/deep` |
| **Projeto** | `/project` |
| **Info** | `/status` `/whoami` `/platform` |
| **Computador** | `/sys` `/ps` `/open` `/url` `/shot` `/shutdown` `/restart` `/confirm` `/approve` `/deny` |
| **Sistema** | `/debug` `/help` |

Exemplos:

```
Você:  Abra o projeto C:\dev\orbia
Bot:   📁 Projeto alterado... nova conversa criada nele.

Você:  Rode os testes
Bot:   (executa no contexto do Orbia — entendeu a referência)

Você:  /shot
Bot:   📸 [imagem da sua tela]
```

## Arquitetura em 30 segundos

```
src/
├── gateway.mjs           roteador: authz → dedup → comandos → fluxo de IA
├── commandRegistry.mjs   FONTE ÚNICA dos comandos (menu, help, aliases)
├── opencode.mjs          supervisiona `opencode serve` + SDK @opencode-ai/sdk
├── sessionStore.mjs      mapa canal:usuário → {sessão, projeto, modo}
├── computer.mjs          ações diretas no Windows com níveis de segurança
├── sanitize.mjs          remove ANSI/banners + redige segredos na saída
├── logger.mjs            logs locais JSONL com rotação (nunca vão pro chat)
└── adapters/
    ├── telegram.mjs      polling + typing + edição ao vivo
    └── instagram.mjs     Meta Graph API oficial (webhook assinado)
```

Fluxo de uma mensagem:

```
update_id → autorização → dedup (60s) → é comando? → handler local (<300ms)
                                      └→ não → sessão persistente → prompt no
                                         servidor OpenCode → SSE stream → edição
                                         ao vivo no Telegram (sanitizado)
```

## Segurança

- **Default-deny**: só IDs em `TELEGRAM_ALLOWED_USER_IDS` interagem; resto é ignorado sem tocar LLM
- **Segredos**: `.env` fora do git; saída e logs passam por redação automática (`sk-…`, tokens, `KEY=`)
- **Ações sensíveis** (desligar/reiniciar): exigem código de 6 dígitos gerado na hora
  - expira em 5 minutos · funciona uma única vez · vinculado ao usuário que pediu
- **Permissões do agente**: pedidos perigosos do próprio OpenCode viram `/approve`/`/deny` no chat
- **Isolamento de canais**: falha do Instagram não derruba o Telegram (e vice-versa)
- **Logs locais apenas**, com rotação 5 MB × 3 e segredos redigidos

### Limitações honestas

- O gateway roda enquanto sua sessão Windows estiver ativa (task agendada no logon + watchdog de 15 min). Para 100% 24/7 com PC fechado, use um VPS
- Quem tem acesso físico à máquina tem acesso ao `.env`
- Instagram exige conta Meta Business aprovada + URL pública para webhook (ex.: túnel)

## Compatibilidade com Hermes Agent

Registro de comandos extraído da documentação oficial atual do
[Hermes Agent](https://github.com/NousResearch/hermes-agent). Resumo:

- ✅ Suportados: `/new` `/model` `/status` `/stop` `/retry` `/undo` `/sessions` `/resume` `/title` `/compress` `/background` `/approve` `/deny` `/help` `/whoami` `/platform`
- ⚠️ Parciais: `/usage` (tokens internos), `/rollback` (revert de mensagens, não filesystem), `/personality`
- ❌ N/A nesta versão: `/voice` (áudio), `/cron` (agendamentos), `/reload-mcp`, `/sethome`

Extras que o Hermes não tem: modos `/auto` `/fast` `/code` `/deep`, `/project`, controle direto do PC (`/sys` `/ps` `/shot`…).

## Testes

```bash
npm test
```

Cobrem: sanitização ANSI/banner `[0m]`, redação de segredos, autorização allow/deny,
deduplicação, expiração e vínculo de tokens de confirmação, persistência de sessões,
isolamento entre canais e geração do menu a partir do registry.

## Portabilidade (rodar em outra máquina / outro OpenCode)

O gateway não tem nada fixo por máquina. Tudo que varia vive no `.env`:

| O quê | Variável |
|---|---|
| Projeto padrão do agente | `DEFAULT_WORKSPACE` |
| Modelo de cada modo | `MODEL_AUTO` `MODEL_FAST` `MODEL_CODE` `MODEL_DEEP` (`provider/model` do seu OpenCode) |
| Cadeia de fallback | `MODEL_FALLBACKS` (vírgula = próxima tentativa) |
| Servidor | `OPENCODE_SERVER_URL/USERNAME/PASSWORD` |
| Quem pode usar | `TELEGRAM_ALLOWED_USER_IDS` |

Checklist para um novo deploy:

```bash
git clone … && cd agent-gateway && npm install
cp .env.example .env      # preencha token + IDs
node scripts/../src/gateway.mjs   # ou: npm start
```

Descobrir os modelos disponíveis no SEU opencode:

```bash
opencode models
```

## Licença

MIT — use, estude, adapte. Sem garantias.
