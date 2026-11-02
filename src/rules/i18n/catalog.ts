import type { RuleId, RuleResult } from "../queries.js";

export type Locale = "en" | "es" | "pt";

type MessagePair = {
  summary: (m: RuleResult) => string;
  suggestion: (m: RuleResult) => string;
};

export const CATALOG: Record<RuleId, Record<Locale, MessagePair>> = {
  slow_route: {
    en: {
      summary: (m) => `Route ${m.subject} is slow (p95 ${m.metrics.p95}ms)`,
      suggestion: () =>
        "Heavy work inside the request — move it to a queue and respond with a draft.",
    },
    pt: {
      summary: (m) => `Rota ${m.subject} está lenta (p95 ${m.metrics.p95}ms)`,
      suggestion: () =>
        "Trabalho pesado dentro da requisição — mover pra fila e responder rápido.",
    },
    es: {
      summary: (m) =>
        `La ruta ${m.subject} está lenta (p95 ${m.metrics.p95}ms)`,
      suggestion: () =>
        "Trabajo pesado dentro de la solicitud — mover a una cola y responder rápido.",
    },
  },
  regression: {
    en: {
      summary: (m) =>
        `Route ${m.subject} regressed (p95 up ${m.metrics.variacaoPct}% vs last week)`,
      suggestion: () => "Compare with the previous deploy; revert if serious.",
    },
    pt: {
      summary: (m) =>
        `Rota ${m.subject} regrediu (p95 subiu ${m.metrics.variacaoPct}% vs semana passada)`,
      suggestion: () =>
        "Comparar com o deploy anterior; revertar se for grave.",
    },
    es: {
      summary: (m) =>
        `La ruta ${m.subject} empeoró (p95 subió ${m.metrics.variacaoPct}% vs la semana pasada)`,
      suggestion: () =>
        "Comparar con el despliegue anterior; revertir si es grave.",
    },
  },
  top_consumer: {
    en: {
      summary: (m) =>
        `${m.subject} is the top time consumer (${m.metrics.tempoTotalMs}ms total)`,
      suggestion: () =>
        "High p95 and high volume — the same fixes as slow_route apply here.",
    },
    pt: {
      summary: (m) =>
        `${m.subject} é a maior consumidora de tempo (${m.metrics.tempoTotalMs}ms no total)`,
      suggestion: () =>
        "P95 alto e muito volume — mesmas correções de rota lenta se aplicam.",
    },
    es: {
      summary: (m) =>
        `${m.subject} es la mayor consumidora de tiempo (${m.metrics.tempoTotalMs}ms en total)`,
      suggestion: () =>
        "P95 alto y mucho volumen — aplican las mismas correcciones de ruta lenta.",
    },
  },
  error_spike: {
    en: {
      summary: (m) =>
        `Error spike on ${m.subject} (${m.metrics.taxaErro} error rate)`,
      suggestion: () => "Check the latest deploy and logs immediately.",
    },
    pt: {
      summary: (m) =>
        `Erro em alta em ${m.subject} (taxa ${m.metrics.taxaErro})`,
      suggestion: () => "Checar o último deploy e os logs imediatamente.",
    },
    es: {
      summary: (m) =>
        `Pico de errores en ${m.subject} (tasa ${m.metrics.taxaErro})`,
      suggestion: () => "Revisar el último despliegue y los logs de inmediato.",
    },
  },
  slow_query: {
    en: {
      summary: (m) =>
        `Slow query detected (${m.metrics.meanExecMs}ms avg): ${m.subject}`,
      suggestion: () =>
        "Add the right index; EXPLAIN ANALYZE before and after.",
    },
    pt: {
      summary: (m) =>
        `Consulta lenta detectada (${m.metrics.meanExecMs}ms em média): ${m.subject}`,
      suggestion: () =>
        "Adicionar o índice certo; EXPLAIN ANALYZE antes e depois.",
    },
    es: {
      summary: (m) =>
        `Consulta lenta detectada (${m.metrics.meanExecMs}ms promedio): ${m.subject}`,
      suggestion: () =>
        "Agregar el índice correcto; EXPLAIN ANALYZE antes y después.",
    },
  },
  high_variance: {
    en: {
      summary: (m) =>
        `${m.subject} has high latency variance (p99 ${m.metrics.p99}ms vs p50 ${m.metrics.p50}ms)`,
      suggestion: () =>
        "Likely cold start or lock contention, not a constant problem.",
    },
    pt: {
      summary: (m) =>
        `${m.subject} tem variância alta de latência (p99 ${m.metrics.p99}ms vs p50 ${m.metrics.p50}ms)`,
      suggestion: () =>
        "Provável cold start ou lock, não é problema constante.",
    },
    es: {
      summary: (m) =>
        `${m.subject} tiene alta varianza de latencia (p99 ${m.metrics.p99}ms vs p50 ${m.metrics.p50}ms)`,
      suggestion: () =>
        "Probable cold start o lock, no es un problema constante.",
    },
  },
  platform_error_concentration: {
    en: {
      summary: (m) =>
        `Errors concentrated on platform ${m.subject} (${m.metrics.taxaErro} vs avg ${m.metrics.mediaOutrasPlataformas})`,
      suggestion: () =>
        "Likely a client-side bug on that platform, not the backend.",
    },
    pt: {
      summary: (m) =>
        `Erros concentrados na plataforma ${m.subject} (${m.metrics.taxaErro} vs média ${m.metrics.mediaOutrasPlataformas})`,
      suggestion: () =>
        "Provável bug de client nessa plataforma, não do backend.",
    },
    es: {
      summary: (m) =>
        `Errores concentrados en la plataforma ${m.subject} (${m.metrics.taxaErro} vs promedio ${m.metrics.mediaOutrasPlataformas})`,
      suggestion: () =>
        "Probable bug del cliente en esa plataforma, no del backend.",
    },
  },
  timeout_spike: {
    en: {
      summary: (m) =>
        `Timeouts spiking on ${m.subject} (${m.metrics.taxaTimeout} rate)`,
      suggestion: () =>
        "The function is hitting its time limit — split the work or raise the limit.",
    },
    pt: {
      summary: (m) =>
        `Timeouts em alta em ${m.subject} (taxa ${m.metrics.taxaTimeout})`,
      suggestion: () =>
        "A função está batendo no limite de tempo — dividir o trabalho ou aumentar o limite.",
    },
    es: {
      summary: (m) =>
        `Timeouts en aumento en ${m.subject} (tasa ${m.metrics.taxaTimeout})`,
      suggestion: () =>
        "La función está llegando al límite de tiempo — dividir el trabajo o aumentar el límite.",
    },
  },
  ai_cost_spike: {
    en: {
      summary: (m) =>
        `AI cost per call went up without more volume (now $${m.metrics.custoMedioHoje} vs $${m.metrics.custoMedioAntes})`,
      suggestion: () =>
        "Route to a smaller model, shorten the prompt, or cache repeated answers.",
    },
    pt: {
      summary: (m) =>
        `Custo de IA por chamada subiu sem subir volume (agora $${m.metrics.custoMedioHoje} vs $${m.metrics.custoMedioAntes})`,
      suggestion: () =>
        "Rotear pra um modelo menor, encurtar o prompt, ou cachear respostas repetidas.",
    },
    es: {
      summary: (m) =>
        `El costo de IA por llamada subió sin subir el volumen (ahora $${m.metrics.custoMedioHoje} vs $${m.metrics.custoMedioAntes})`,
      suggestion: () =>
        "Enrutar a un modelo más pequeño, acortar el prompt, o cachear respuestas repetidas.",
    },
  },
  ai_failure_rate: {
    en: {
      summary: (m) =>
        `Model ${m.subject} has a high failure rate (${m.metrics.taxaFalha})`,
      suggestion: () => "Check the prompt or the provider's rate limit.",
    },
    pt: {
      summary: (m) =>
        `Modelo ${m.subject} tem taxa de falha alta (${m.metrics.taxaFalha})`,
      suggestion: () => "Checar o prompt ou o rate limit do provedor.",
    },
    es: {
      summary: (m) =>
        `El modelo ${m.subject} tiene una tasa de fallas alta (${m.metrics.taxaFalha})`,
      suggestion: () => "Revisar el prompt o el límite de tasa del proveedor.",
    },
  },
  peak_hour_bottleneck: {
    en: {
      summary: (m) =>
        `${m.subject} bottlenecks around hour ${m.metrics.horaDoDia} (p95 ${m.metrics.p95}ms vs avg ${m.metrics.p95Medio}ms)`,
      suggestion: () => "Likely missing autoscaling for that peak hour.",
    },
    pt: {
      summary: (m) =>
        `${m.subject} trava perto da hora ${m.metrics.horaDoDia} (p95 ${m.metrics.p95}ms vs média ${m.metrics.p95Medio}ms)`,
      suggestion: () => "Provável falta de autoscaling nesse horário de pico.",
    },
    es: {
      summary: (m) =>
        `${m.subject} se traba cerca de la hora ${m.metrics.horaDoDia} (p95 ${m.metrics.p95}ms vs promedio ${m.metrics.p95Medio}ms)`,
      suggestion: () => "Probable falta de autoscaling en ese horario pico.",
    },
  },
  post_deploy_regression: {
    en: {
      summary: (m) =>
        `${m.subject} regressed right after the latest deploy (p95 ${m.metrics.p95Depois}ms vs ${m.metrics.p95Antes}ms before)`,
      suggestion: () => "Compare with the previous deploy; revert if serious.",
    },
    pt: {
      summary: (m) =>
        `${m.subject} regrediu logo após o último deploy (p95 ${m.metrics.p95Depois}ms vs ${m.metrics.p95Antes}ms antes)`,
      suggestion: () =>
        "Comparar com o deploy anterior; revertar se for grave.",
    },
    es: {
      summary: (m) =>
        `${m.subject} empeoró justo después del último despliegue (p95 ${m.metrics.p95Depois}ms vs ${m.metrics.p95Antes}ms antes)`,
      suggestion: () =>
        "Comparar con el despliegue anterior; revertir si es grave.",
    },
  },
};
