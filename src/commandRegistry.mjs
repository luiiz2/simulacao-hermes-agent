// CommandRegistry — single source of truth for slash commands:
// Telegram "/" menu, /help output, parser aliases, permissions.
// Handlers are bound at startup via bindHandlers().

export const DEFS = [
  // SESSION
  { name: "new", aliases: ["reset"], cat: "SESSÃO", perm: "user", requiresAI: false, desc: "Nova conversa (mantém projeto)" },
  { name: "sessions", aliases: [], cat: "SESSÃO", perm: "user", requiresAI: false, desc: "Lista conversas anteriores" },
  { name: "resume", aliases: [], cat: "SESSÃO", perm: "user", requiresAI: false, desc: "/resume <id> retoma conversa" },
  { name: "title", aliases: [], cat: "SESSÃO", perm: "user", requiresAI: false, desc: "/title <nome> nomeia conversa" },
  { name: "retry", aliases: [], cat: "SESSÃO", perm: "user", requiresAI: true, desc: "Reenvia última mensagem" },
  { name: "undo", aliases: [], cat: "SESSÃO", perm: "user", requiresAI: false, desc: "Desfaz última troca" },
  { name: "compress", aliases: [], cat: "SESSÃO", perm: "user", requiresAI: false, desc: "Comprime contexto da conversa" },
  { name: "background", aliases: ["bg"], cat: "SESSÃO", perm: "admin", requiresAI: true, desc: "/bg <tarefa> roda em segundo plano" },
  { name: "stop", aliases: [], cat: "SESSÃO", perm: "user", requiresAI: false, desc: "Cancela tarefa em andamento" },

  // MODELO
  { name: "model", aliases: [], cat: "MODELO", perm: "user", requiresAI: false, desc: "Mostra/troca modelo atual" },
  { name: "auto", aliases: [], cat: "MODELO", perm: "user", requiresAI: false, desc: "Modo AUTO (padrão)" },
  { name: "fast", aliases: [], cat: "MODELO", perm: "user", requiresAI: false, desc: "Modo FAST · respostas rápidas" },
  { name: "code", aliases: [], cat: "MODELO", perm: "user", requiresAI: false, desc: "Modo CODE · programação" },
  { name: "deep", aliases: [], cat: "MODELO", perm: "user", requiresAI: false, desc: "Modo DEEP · raciocínio profundo" },

  // PROJETO
  { name: "project", aliases: ["projeto"], cat: "PROJETO", perm: "user", requiresAI: false, desc: "Mostra/troca projeto ativo" },
  { name: "status", aliases: [], cat: "INFO", perm: "user", requiresAI: false, desc: "Status do agente e sessão" },
  { name: "whoami", aliases: [], cat: "INFO", perm: "user", requiresAI: false, desc: "Seu nível de acesso" },
  { name: "platform", aliases: ["platforms"], cat: "INFO", perm: "admin", requiresAI: false, desc: "Estado dos canais conectados" },

  // COMPUTADOR
  { name: "sys", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "CPU, RAM, disco e uptime" },
  { name: "ps", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "Processos pesados agora" },
  { name: "open", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "/open <app> abre aplicativo" },
  { name: "url", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "/url <link> abre no navegador" },
  { name: "shot", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "Captura de tela" },
  { name: "shutdown", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "Desligar PC (pede confirmação)" },
  { name: "restart", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "Reiniciar PC (pede confirmação)" },
  { name: "confirm", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "/confirm <código> confirma ação" },
  { name: "approve", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "Aprova permissão pendente do agente" },
  { name: "deny", aliases: [], cat: "COMPUTADOR", perm: "admin", requiresAI: false, desc: "Nega permissão pendente do agente" },

  // SISTEMA
  { name: "debug", aliases: ["verbose"], cat: "SISTEMA", perm: "admin", requiresAI: false, desc: "Liga/desliga detalhes técnicos" },
  { name: "help", aliases: ["ajuda"], cat: "SISTEMA", perm: "user", requiresAI: false, desc: "Esta lista de comandos" },
  { name: "commands", aliases: [], cat: "SISTEMA", perm: "user", requiresAI: false, desc: "Mesmo que /help" },
];

const HANDLERS = new Map();
const INDEX = new Map();
for (const d of DEFS) {
  INDEX.set(d.name, d);
  for (const a of d.aliases) INDEX.set(a, d);
}

export function bindHandlers(map) {
  for (const [k, fn] of Object.entries(map)) HANDLERS.set(k, fn);
}

export function resolve(name) {
  const def = INDEX.get(name.replace(/^\//, "").toLowerCase());
  return def ? { def, handler: HANDLERS.get(def.name) } : null;
}

export function menuForBot(cap = 60) {
  return DEFS.slice(0, cap).map((d) => ({ command: d.name, description: d.desc }));
}

export function helpText() {
  const cats = new Map();
  for (const d of DEFS) {
    if (!cats.has(d.cat)) cats.set(d.cat, []);
    cats.get(d.cat).push(`/${d.name}${d.aliases.length ? ` (${d.aliases.map((a) => "/" + a).join(", ")})` : ""} — ${d.desc}`);
  }
  return [...cats.entries()].map(([cat, lines]) => `${cat}\n${lines.join("\n")}`).join("\n\n");
}
