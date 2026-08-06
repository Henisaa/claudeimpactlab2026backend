/**
 * Las dos llamadas a Claude del sistema, con sus guardrails.
 *
 *  1. extraerDocumento: foto → borrador estructurado con cita literal.
 *     (Mismo prompt y esquema que el prototipo del frontend.)
 *  2. responderDesdeElBaul: pregunta + fragmentos recuperados por rag.js →
 *     respuesta en lenguaje simple citando cada afirmación.
 *
 * Lo que Claude NO hace aquí, por diseño del proyecto: decidir urgencia
 * (motor.js), calcular o sugerir dosis, resolver contradicciones, responder
 * con conocimiento propio si la recuperación no trajo respaldo.
 */

import Anthropic from "@anthropic-ai/sdk";
import { anonimizar } from "./seguridad.js";

const MODELO_VISION = process.env.CLAUDE_MODELO_VISION ?? "claude-opus-5";
const MODELO_RAG = process.env.CLAUDE_MODELO ?? "claude-sonnet-5";

let cliente = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error("Falta ANTHROPIC_API_KEY en el .env del backend.");
    err.status = 500;
    throw err;
  }
  cliente ??= new Anthropic();
  return cliente;
}

// ---------------------------------------------------------------------------
// 1. Extracción de documentos fotografiados
// ---------------------------------------------------------------------------

const SYSTEM_EXTRACCION = `Eres el extractor de documentación postoperatoria del proyecto de continuidad de cuidados.
Tu única función es leer documentos médicos fotografiados o escaneados y estructurar lo que dicen.

Reglas que no puedes romper:

1. Transcribe, no interpretes. Para cada campo, "texto_original" debe ser la cita literal
   del documento, tal como está escrita. Si el documento abrevia, tú abrevias igual.
2. Nunca completes un dato que no esté en el documento. Si no aparece, el campo va en null
   y lo declaras en "datos_faltantes". No infieras una dosis, una fecha ni una frecuencia.
3. Las dosis, frecuencias y duraciones las escribió un profesional. Cópialas exactamente.
   No las conviertas de unidades, no las corrijas, no las completes aunque parezcan incompletas.
4. Si dos partes del documento se contradicen, describe el conflicto en "conflictos" y deja
   ambos valores. No elijas cuál es el correcto.
5. Marca "confianza" según lo que realmente puedas leer: "alta" si el texto es nítido e
   inequívoco, "media" si tuviste que interpretar caligrafía o el texto está parcialmente
   cortado, "baja" si estás adivinando. Prefiere declarar baja confianza antes que acertar.
6. Si detectas datos que parecen ser de una persona real (RUN, nombre completo, teléfono,
   dirección), no los transcribas: ponlos como null y anótalo en "advertencias". Este sistema
   trabaja únicamente con documentos sintéticos.
7. No emitas diagnósticos, no evalúes gravedad y no sugieras conductas. Otra parte del
   sistema decide eso a partir de una matriz clínica validada por un profesional.`;

const CAMPO_TRAZABLE = {
  type: ["object", "null"],
  additionalProperties: false,
  required: ["valor", "texto_original", "confianza"],
  properties: {
    valor: { type: ["string", "null"] },
    texto_original: { type: "string" },
    confianza: { type: "string", enum: ["alta", "media", "baja"] },
  },
};

const ESQUEMA_EXTRACCION = {
  type: "object",
  additionalProperties: false,
  required: [
    "tipo_documento",
    "fecha_alta",
    "medicamentos",
    "indicaciones_curacion",
    "proximo_control",
    "alergias",
    "datos_faltantes",
    "conflictos",
    "advertencias",
  ],
  properties: {
    tipo_documento: {
      type: "string",
      enum: [
        "informe_alta",
        "receta",
        "protocolo_operatorio",
        "examen",
        "indicaciones_curacion",
        "desconocido",
      ],
    },
    fecha_alta: CAMPO_TRAZABLE,
    medicamentos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nombre", "dosis", "frecuencia", "duracion", "texto_original", "confianza"],
        properties: {
          nombre: { type: "string" },
          dosis: { type: ["string", "null"] },
          frecuencia: { type: ["string", "null"] },
          duracion: { type: ["string", "null"] },
          texto_original: { type: "string" },
          confianza: { type: "string", enum: ["alta", "media", "baja"] },
        },
      },
    },
    indicaciones_curacion: CAMPO_TRAZABLE,
    proximo_control: CAMPO_TRAZABLE,
    alergias: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["valor", "texto_original", "confianza"],
        properties: {
          valor: { type: "string" },
          texto_original: { type: "string" },
          confianza: { type: "string", enum: ["alta", "media", "baja"] },
        },
      },
    },
    datos_faltantes: { type: "array", items: { type: "string" } },
    conflictos: { type: "array", items: { type: "string" } },
    advertencias: { type: "array", items: { type: "string" } },
  },
};

/**
 * @param imagenes  [{ mediaType, base64 }]
 * @returns { borrador, uso }
 */
export async function extraerDocumento(imagenes, textoDocumento = "") {
  const textoSeguro = anonimizar(textoDocumento);
  if (process.env.CLAUDE_MOCK !== "false" || !process.env.ANTHROPIC_API_KEY) {
    return { borrador: mockExtraccion(textoDocumento, textoSeguro), uso: { tokensEntrada: 0, tokensSalida: 0, mock: true } };
  }
  const respuesta = await anthropic().messages.create({
    model: MODELO_VISION,
    max_tokens: 16000,
    system: SYSTEM_EXTRACCION,
    output_config: { format: { type: "json_schema", schema: ESQUEMA_EXTRACCION } },
    messages: [
      {
        role: "user",
        content: [
          ...(textoSeguro ? [{ type: "text", text: `Texto del documento (anonimizado):\n${textoSeguro}` }] : []),
          ...imagenes.map((img) => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.base64 },
          })),
          {
            type: "text",
            text: "Extrae la información de estos documentos siguiendo tus reglas. Recuerda: cita literal en texto_original, null donde el documento no diga nada.",
          },
        ],
      },
    ],
  });

  if (respuesta.stop_reason === "refusal") {
    const err = new Error(
      "El modelo declinó procesar estas imágenes. Verifica que sean documentos sintéticos del proyecto.",
    );
    err.status = 422;
    throw err;
  }
  const texto = respuesta.content.find((b) => b.type === "text");
  if (!texto) {
    const err = new Error("El modelo no devolvió contenido estructurado.");
    err.status = 502;
    throw err;
  }
  return {
    borrador: JSON.parse(texto.text),
    uso: {
      tokensEntrada: respuesta.usage.input_tokens,
      tokensSalida: respuesta.usage.output_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Respuesta RAG desde el baúl
// ---------------------------------------------------------------------------

const SYSTEM_RAG = `Eres el asistente del "baúl" de una persona mayor operada de la cadera
(endoprótesis total de cadera). Respondes preguntas del paciente o su cuidador usando
ÚNICAMENTE los fragmentos recuperados que se te entregan, numerados [1], [2], etc.
Los fragmentos pueden ser documentos del paciente, fuentes oficiales, notas curatoriales
del proyecto o filas de la matriz clínica. No presentes una nota del proyecto como si
fuera una publicación oficial.

Reglas que no puedes romper:

1. Cada afirmación de tu respuesta debe terminar con la cita [n] del fragmento que la
   respalda. Sin fragmento que la respalde, la afirmación no se escribe.
2. Si los fragmentos no contienen la respuesta, dilo con claridad: "Sus documentos y las
   guías disponibles no responden esta pregunta" y recomienda anotarla para el próximo
   control o llamar a Salud Responde (600 360 7777). No completes con conocimiento propio.
3. No diagnostiques, no evalúes gravedad y no digas si un síntoma es normal o preocupante,
   salvo que un fragmento lo diga textualmente (y entonces lo citas).
4. Nunca indiques, calcules ni ajustes dosis. Si preguntan por un medicamento, repite solo
   lo que dice el documento del paciente, citándolo. Si la receta no lo dice, di que eso
   lo escribió el profesional y hay que mirar la receta o preguntar en el control.
5. Si dos fragmentos se contradicen, muestra ambos y di que debe aclararlo el profesional.
6. Si la pregunta sugiere una situación urgente (dificultad para respirar, sangrado
   abundante, dolor de pecho, pérdida de conciencia, caída), responde primero que ante una
   urgencia debe llamar a los servicios de urgencia o consultar de inmediato, y no sigas
   con contenido documental.
7. Habla en lenguaje simple, frases cortas, tono cálido y respetuoso, en español de Chile.
   La persona que lee tiene 65 años o más. Nada de jerga clínica sin explicarla.
8. Distingue siempre entre "sus documentos" (lo que el equipo que la operó escribió para
   ella), "las fuentes oficiales" (información publicada por una institución) y "las
   notas del proyecto" (material curado por el equipo). Una nota del proyecto no es una
   fuente oficial por sí sola.`;

const ESQUEMA_RAG = {
  type: "object",
  additionalProperties: false,
  required: ["respuesta", "fragmentos_citados", "informacion_insuficiente", "requiere_revision_profesional"],
  properties: {
    respuesta: {
      type: "string",
      description: "Respuesta en lenguaje simple con citas [n] al final de cada afirmación",
    },
    fragmentos_citados: {
      type: "array",
      items: { type: "integer" },
      description: "Números de los fragmentos realmente usados",
    },
    informacion_insuficiente: { type: "boolean" },
    requiere_revision_profesional: { type: "boolean" },
  },
};

export async function responderDesdeElBaul(pregunta, fragmentos, contexto) {
  const preguntaSegura = anonimizar(pregunta);
  const fragmentosSeguros = fragmentos.map((f) => ({ ...f, contenido: anonimizar(f.contenido) }));
  const contextoSeguro = anonimizar(contexto);
  if (process.env.CLAUDE_MOCK !== "false" || !process.env.ANTHROPIC_API_KEY) {
    const primero = fragmentosSeguros[0];
    return {
      respuesta: primero
        ? `${primero.contenido.slice(0, 500)} [1]`
        : "Sus documentos y las guías disponibles no responden esta pregunta.",
      fragmentos_citados: primero ? [1] : [],
      informacion_insuficiente: !primero,
      requiere_revision_profesional: true,
      uso: { tokensEntrada: 0, tokensSalida: 0, mock: true },
    };
  }
  const listado = fragmentosSeguros
    .map(
      (f, i) =>
        `[${i + 1}] (${etiquetaFragmento(f.tipo)} — ${f.fuente}${f.seccion ? `, ${f.seccion}` : ""})\n${f.contenido}`,
    )
    .join("\n\n");

  const respuesta = await anthropic().messages.create({
    model: MODELO_RAG,
    max_tokens: 2000,
    system: SYSTEM_RAG,
    output_config: { format: { type: "json_schema", schema: ESQUEMA_RAG } },
    messages: [
      {
        role: "user",
         content: `Contexto del paciente (sintético): ${contextoSeguro}

Fragmentos recuperados del baúl:

${listado || "(la búsqueda no recuperó ningún fragmento)"}

Pregunta: ${preguntaSegura}`,
      },
    ],
  });

  if (respuesta.stop_reason === "refusal") {
    const err = new Error("El modelo declinó responder esta pregunta.");
    err.status = 422;
    throw err;
  }
  const texto = respuesta.content.find((b) => b.type === "text");
  if (!texto) {
    const err = new Error("El modelo no devolvió contenido estructurado.");
    err.status = 502;
    throw err;
  }
  return {
    ...JSON.parse(texto.text),
    uso: {
      tokensEntrada: respuesta.usage.input_tokens,
      tokensSalida: respuesta.usage.output_tokens,
    },
  };
}

function etiquetaFragmento(tipo) {
  switch (tipo) {
    case "documento_paciente":
      return "documento del paciente";
    case "nota_proyecto":
      return "nota curada del proyecto";
    case "matriz_clinica":
      return "matriz clínica con fuente";
    case "guia_oficial":
      return "fuente oficial";
    default:
      return "fuente no clasificada";
  }
}

function mockExtraccion(texto = "", textoSeguro = "") {
  const fecha = texto.match(/\b(20\d{2}-\d{2}-\d{2}|\d{2}[/-]\d{2}[/-]20\d{2})\b/);
  const normalizarFecha = (valor) => {
    if (!valor) return null;
    if (/^\d{2}[/-]/.test(valor)) {
      const [d, m, y] = valor.split(/[/-]/);
      return `${y}-${m}-${d}`;
    }
    return valor;
  };
  const medicamentos = [];
  for (const nombre of ["Paracetamol", "Rivaroxabán", "Rivaroxaban", "Aspirina", "Losartán", "Losartan"]) {
    const encontrado = texto.match(new RegExp(`${nombre}[^\\n.;]*`, "i"));
    if (!encontrado) continue;
    const linea = encontrado[0].trim();
    medicamentos.push({
      nombre: linea.match(new RegExp(nombre, "i"))[0],
      dosis: linea.match(/\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg)\b/i)?.[0] ?? null,
      frecuencia: linea.match(/cada\s+[^,;.]+/i)?.[0] ?? null,
      duracion: linea.match(/por\s+[^,;.]+/i)?.[0] ?? null,
      texto_original: linea,
      confianza: "alta",
    });
  }
  return {
    tipo_documento: "informe_alta",
    fecha_alta: fecha ? { valor: normalizarFecha(fecha[0]), texto_original: fecha[0], confianza: "alta" } : null,
    medicamentos,
    indicaciones_curacion: null,
    proximo_control: null,
    alergias: [],
    datos_faltantes: [textoSeguro ? "Extracción MOCK basada en texto; confirmar contra el documento original." : "Extracción MOCK: no se interpreta el contenido visual."],
    conflictos: [],
    advertencias: ["Resultado simulado; confirmar contra el documento original."],
  };
}
