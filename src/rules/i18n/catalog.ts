import { code, count, hourOfDay, ms, pct, usd } from "../format.js";
import type { RuleId, RuleResult } from "../queries.js";

export type Locale = "en" | "es" | "pt";

type MessagePair = {
  summary: (m: RuleResult) => string;
  suggestion: (m: RuleResult) => string;
};

export const CATALOG: Record<RuleId, Record<Locale, MessagePair>> = {
  slow_route: {
    en: {
      summary: (m) =>
        `Route ${code(m.subject)} is slow (p95 ${ms(m.metrics.p95, "en")})`,
      suggestion: () =>
        "Heavy work inside the request — move it to a queue and respond with a draft.",
    },
    pt: {
      summary: (m) =>
        `Rota ${code(m.subject)} está lenta (p95 ${ms(m.metrics.p95, "pt")})`,
      suggestion: () =>
        "Trabalho pesado dentro da requisição — mover pra fila e responder rápido.",
    },
    es: {
      summary: (m) =>
        `La ruta ${code(m.subject)} está lenta (p95 ${ms(m.metrics.p95, "es")})`,
      suggestion: () =>
        "Trabajo pesado dentro de la solicitud — mover a una cola y responder rápido.",
    },
  },
  regression: {
    en: {
      summary: (m) =>
        `Route ${code(m.subject)} regressed (p95 up ${m.metrics.changePct}% vs last week: ${ms(m.metrics.p95Before, "en")} → ${ms(m.metrics.p95, "en")})`,
      suggestion: () => "Compare with the previous deploy; revert if serious.",
    },
    pt: {
      summary: (m) =>
        `Rota ${code(m.subject)} regrediu (p95 subiu ${m.metrics.changePct}% vs semana passada: ${ms(m.metrics.p95Before, "pt")} → ${ms(m.metrics.p95, "pt")})`,
      suggestion: () =>
        "Comparar com o deploy anterior; reverter se for grave.",
    },
    es: {
      summary: (m) =>
        `La ruta ${code(m.subject)} empeoró (p95 subió ${m.metrics.changePct}% vs la semana pasada: ${ms(m.metrics.p95Before, "es")} → ${ms(m.metrics.p95, "es")})`,
      suggestion: () =>
        "Comparar con el despliegue anterior; revertir si es grave.",
    },
  },
  top_consumer: {
    en: {
      summary: (m) =>
        `${code(m.subject)} is the top time consumer (${ms(m.metrics.totalMs, "en")} total)`,
      suggestion: () =>
        "High p95 and high volume — the same fixes as a slow route apply here.",
    },
    pt: {
      summary: (m) =>
        `${code(m.subject)} é a maior consumidora de tempo (${ms(m.metrics.totalMs, "pt")} no total)`,
      suggestion: () =>
        "P95 alto e muito volume — mesmas correções de rota lenta se aplicam.",
    },
    es: {
      summary: (m) =>
        `${code(m.subject)} es la mayor consumidora de tiempo (${ms(m.metrics.totalMs, "es")} en total)`,
      suggestion: () =>
        "P95 alto y mucho volumen — aplican las mismas correcciones de ruta lenta.",
    },
  },
  error_spike: {
    en: {
      summary: (m) =>
        `Error spike on ${code(m.subject)} (${pct(m.metrics.errorRate, "en")} of requests failed in the worst hour)`,
      suggestion: () => "Check the latest deploy and logs immediately.",
    },
    pt: {
      summary: (m) =>
        `Erros em alta em ${code(m.subject)} (${pct(m.metrics.errorRate, "pt")} das requisições falharam na pior hora)`,
      suggestion: () => "Checar o último deploy e os logs imediatamente.",
    },
    es: {
      summary: (m) =>
        `Pico de errores en ${code(m.subject)} (${pct(m.metrics.errorRate, "es")} de las solicitudes fallaron en la peor hora)`,
      suggestion: () => "Revisar el último despliegue y los logs de inmediato.",
    },
  },
  slow_query: {
    en: {
      summary: (m) =>
        `Slow query (${ms(m.metrics.meanExecMs, "en")} avg, ${count(m.metrics.calls, "en")} calls): ${code(m.subject)}`,
      suggestion: () =>
        "Add the right index; EXPLAIN ANALYZE before and after.",
    },
    pt: {
      summary: (m) =>
        `Consulta lenta (${ms(m.metrics.meanExecMs, "pt")} em média, ${count(m.metrics.calls, "pt")} chamadas): ${code(m.subject)}`,
      suggestion: () =>
        "Adicionar o índice certo; EXPLAIN ANALYZE antes e depois.",
    },
    es: {
      summary: (m) =>
        `Consulta lenta (${ms(m.metrics.meanExecMs, "es")} promedio, ${count(m.metrics.calls, "es")} llamadas): ${code(m.subject)}`,
      suggestion: () =>
        "Agregar el índice correcto; EXPLAIN ANALYZE antes y después.",
    },
  },
  high_variance: {
    en: {
      summary: (m) =>
        `${code(m.subject)} has high latency variance (p99 ${ms(m.metrics.p99, "en")} vs p50 ${ms(m.metrics.p50, "en")})`,
      suggestion: () =>
        "Likely cold start or lock contention, not a constant problem.",
    },
    pt: {
      summary: (m) =>
        `${code(m.subject)} tem variância alta de latência (p99 ${ms(m.metrics.p99, "pt")} vs p50 ${ms(m.metrics.p50, "pt")})`,
      suggestion: () =>
        "Provável cold start ou lock, não é problema constante.",
    },
    es: {
      summary: (m) =>
        `${code(m.subject)} tiene alta varianza de latencia (p99 ${ms(m.metrics.p99, "es")} vs p50 ${ms(m.metrics.p50, "es")})`,
      suggestion: () =>
        "Probable cold start o lock, no es un problema constante.",
    },
  },
  platform_error_concentration: {
    en: {
      summary: (m) =>
        `Errors concentrated on platform ${code(m.subject)} (${pct(m.metrics.errorRate, "en")} vs ${pct(m.metrics.otherPlatformsRate, "en")} on the others)`,
      suggestion: () =>
        "Likely a client-side bug on that platform, not the backend.",
    },
    pt: {
      summary: (m) =>
        `Erros concentrados na plataforma ${code(m.subject)} (${pct(m.metrics.errorRate, "pt")} vs ${pct(m.metrics.otherPlatformsRate, "pt")} nas outras)`,
      suggestion: () =>
        "Provável bug de client nessa plataforma, não do backend.",
    },
    es: {
      summary: (m) =>
        `Errores concentrados en la plataforma ${code(m.subject)} (${pct(m.metrics.errorRate, "es")} vs ${pct(m.metrics.otherPlatformsRate, "es")} en las demás)`,
      suggestion: () =>
        "Probable bug del cliente en esa plataforma, no del backend.",
    },
  },
  timeout_spike: {
    en: {
      summary: (m) =>
        `Timeouts spiking on ${code(m.subject)} (${pct(m.metrics.timeoutRate, "en")} of requests in the worst hour)`,
      suggestion: () =>
        "The function is hitting its time limit — split the work or raise the limit.",
    },
    pt: {
      summary: (m) =>
        `Timeouts em alta em ${code(m.subject)} (${pct(m.metrics.timeoutRate, "pt")} das requisições na pior hora)`,
      suggestion: () =>
        "A função está batendo no limite de tempo — dividir o trabalho ou aumentar o limite.",
    },
    es: {
      summary: (m) =>
        `Timeouts en aumento en ${code(m.subject)} (${pct(m.metrics.timeoutRate, "es")} de las solicitudes en la peor hora)`,
      suggestion: () =>
        "La función está llegando al límite de tiempo — dividir el trabajo o aumentar el límite.",
    },
  },
  ai_cost_spike: {
    en: {
      summary: (m) =>
        `AI cost per call went up without more volume (now ${usd(m.metrics.avgCostToday, "en")} vs ${usd(m.metrics.avgCostBefore, "en")})`,
      suggestion: () =>
        "Route to a smaller model, shorten the prompt, or cache repeated answers.",
    },
    pt: {
      summary: (m) =>
        `Custo de IA por chamada subiu sem subir volume (agora ${usd(m.metrics.avgCostToday, "pt")} vs ${usd(m.metrics.avgCostBefore, "pt")})`,
      suggestion: () =>
        "Rotear pra um modelo menor, encurtar o prompt, ou cachear respostas repetidas.",
    },
    es: {
      summary: (m) =>
        `El costo de IA por llamada subió sin subir el volumen (ahora ${usd(m.metrics.avgCostToday, "es")} vs ${usd(m.metrics.avgCostBefore, "es")})`,
      suggestion: () =>
        "Enrutar a un modelo más pequeño, acortar el prompt, o cachear respuestas repetidas.",
    },
  },
  ai_failure_rate: {
    en: {
      summary: (m) =>
        `Model ${code(m.subject)} has a high failure rate (${pct(m.metrics.failureRate, "en")} of ${count(m.metrics.calls, "en")} calls)`,
      suggestion: () => "Check the prompt or the provider's rate limit.",
    },
    pt: {
      summary: (m) =>
        `Modelo ${code(m.subject)} tem taxa de falha alta (${pct(m.metrics.failureRate, "pt")} de ${count(m.metrics.calls, "pt")} chamadas)`,
      suggestion: () => "Checar o prompt ou o rate limit do provedor.",
    },
    es: {
      summary: (m) =>
        `El modelo ${code(m.subject)} tiene una tasa de fallas alta (${pct(m.metrics.failureRate, "es")} de ${count(m.metrics.calls, "es")} llamadas)`,
      suggestion: () => "Revisar el prompt o el límite de tasa del proveedor.",
    },
  },
  peak_hour_bottleneck: {
    en: {
      summary: (m) =>
        `${code(m.subject)} slows down around ${hourOfDay(m.metrics.hourOfDay, m.metrics.timeZone)} (p95 ${ms(m.metrics.p95, "en")} vs ${ms(m.metrics.avgP95, "en")} on average, last 7 days)`,
      suggestion: () =>
        "Something heavier runs at that hour (a job, a cron, a traffic peak) — check what overlaps with it.",
    },
    pt: {
      summary: (m) =>
        `${code(m.subject)} fica lenta por volta das ${hourOfDay(m.metrics.hourOfDay, m.metrics.timeZone)} (p95 ${ms(m.metrics.p95, "pt")} vs ${ms(m.metrics.avgP95, "pt")} na média, últimos 7 dias)`,
      suggestion: () =>
        "Algo mais pesado roda nesse horário (job, cron, pico de uso) — ver o que coincide com ele.",
    },
    es: {
      summary: (m) =>
        `${code(m.subject)} se vuelve lenta alrededor de las ${hourOfDay(m.metrics.hourOfDay, m.metrics.timeZone)} (p95 ${ms(m.metrics.p95, "es")} vs ${ms(m.metrics.avgP95, "es")} en promedio, últimos 7 días)`,
      suggestion: () =>
        "Algo más pesado corre a esa hora (un job, un cron, un pico de uso) — revisar qué coincide.",
    },
  },
  post_deploy_regression: {
    en: {
      summary: (m) =>
        `${code(m.subject)} regressed right after the latest deploy (p95 ${ms(m.metrics.p95After, "en")} vs ${ms(m.metrics.p95Before, "en")} before)`,
      suggestion: () => "Compare with the previous deploy; revert if serious.",
    },
    pt: {
      summary: (m) =>
        `${code(m.subject)} regrediu logo após o último deploy (p95 ${ms(m.metrics.p95After, "pt")} vs ${ms(m.metrics.p95Before, "pt")} antes)`,
      suggestion: () =>
        "Comparar com o deploy anterior; reverter se for grave.",
    },
    es: {
      summary: (m) =>
        `${code(m.subject)} empeoró justo después del último despliegue (p95 ${ms(m.metrics.p95After, "es")} vs ${ms(m.metrics.p95Before, "es")} antes)`,
      suggestion: () =>
        "Comparar con el despliegue anterior; revertir si es grave.",
    },
  },
};
