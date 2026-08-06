/**
 * Notificaciones a la persona de apoyo — canal WhatsApp.
 *
 * Dos decisiones de diseño que son del proyecto, no del proveedor:
 *
 *  1. EL MENSAJE NO LLEVA DATOS CLÍNICOS. WhatsApp es un canal de terceros y
 *     el contenido se muestra en la pantalla de bloqueo, donde lo lee
 *     cualquiera que tome el teléfono. Se avisa que hay algo que requiere
 *     apoyo y se entrega un enlace; el detalle vive detrás de la sesión
 *     autenticada, con auditoría de quién lo leyó (Ley 21.719 y Ley 20.584).
 *  2. NO SE ENVÍA NADA SIN CONSENTIMIENTO `contacto_telefonico` VIGENTE del
 *     paciente. Sin eso la notificación queda 'cancelada' con su motivo, no
 *     se envía en silencio.
 *
 * El proveedor se elige con NOTIFICACIONES_PROVEEDOR y ninguno de ellos es
 * necesario para la demo: el modo por defecto ('simulado') redacta y registra
 * el mensaje real sin salir a internet.
 */

import { db } from "./db.js";
import { consentimientoVigente } from "./auth.js";
import { descifrar } from "./seguridad.js";

const PROVEEDOR = process.env.NOTIFICACIONES_PROVEEDOR ?? "simulado";
const ENLACE_APP = process.env.APP_URL ?? "http://localhost:3000";

/**
 * Qué dice cada evento. Texto corto, sin jerga y sin dato clínico: describe
 * que hay algo que mirar, nunca qué síntoma ni qué medicamento.
 */
const PLANTILLAS = {
  MEDICACION_SIN_CONFIRMAR: {
    plantilla: "contigo_apoyo_medicacion",
    texto: (n) =>
      `Contigo · ${n} respondió su control de hoy y quedó un punto de sus medicamentos sin confirmar. ` +
      `Es un buen momento para acompañarla a revisarlos. Ver en la app: ${ENLACE_APP}/cuidador`,
  },
  CHECKIN_REQUIERE_APOYO: {
    plantilla: "contigo_apoyo_control",
    texto: (n) =>
      `Contigo · ${n} respondió su control de hoy y hay un punto que conviene conversar con su equipo de salud. ` +
      `Ver el detalle en la app: ${ENLACE_APP}/cuidador`,
  },
  CHECKIN_SIN_RESPUESTA: {
    plantilla: "contigo_apoyo_sin_control",
    texto: (n) =>
      `Contigo · ${n} todavía no responde su control de hoy. Si puede, acompáñela a responderlo: ${ENLACE_APP}/paciente`,
  },
  ALERTA_ESCALADA: {
    plantilla: "contigo_apoyo_urgente",
    texto: (n) =>
      `Contigo · ${n} reportó una señal que necesita atención ahora. ` +
      `Si está con ella, acompáñela a llamar al 131 (SAMU) o a Salud Responde 600 360 7777.`,
  },
  DOS_AMARILLAS_ESCALADAS: {
    plantilla: "contigo_apoyo_control",
    texto: (n) =>
      `Contigo · ${n} lleva dos controles seguidos con puntos por revisar, y su equipo de salud ya fue avisado. ` +
      `Ver en la app: ${ENLACE_APP}/cuidador`,
  },
  CPO24_SIN_RESPUESTA: {
    plantilla: "contigo_apoyo_sin_control",
    texto: (n) =>
      `Contigo · no hemos podido contactar a ${n.toLowerCase()} tras varios intentos. ` +
      `Si está con ella, pídale que responda el llamado de seguimiento.`,
  },
  CPO24_ESCALAMIENTO_ESTABLECIMIENTO: {
    plantilla: "contigo_apoyo_control",
    texto: (n) =>
      `Contigo · el seguimiento de ${n.toLowerCase()} fue derivado a su establecimiento de salud por falta de contacto.`,
  },
  RECORDATORIO_MEDICACION: {
    plantilla: "contigo_apoyo_medicacion",
    texto: (n, p) =>
      `Contigo · hoy hay una medicación programada para las ${p?.horaLocal ?? "hora indicada"}. ` +
      `Es un buen momento para acompañar a ${n.toLowerCase()} a tomar la foto en la app: ${ENLACE_APP}/paciente/medicacion`,
  },
  MEDICACION_VERIFICADA: {
    plantilla: "contigo_apoyo_medicacion",
    texto: (n, p) => {
      const desenlace = {
        coincide: "coincide con el plan registrado",
        no_coincide: "no coincide con el plan registrado y quedó marcada para revisión del equipo de salud",
        no_se_puede_confirmar: "no se pudo confirmar con la foto",
      }[p?.resultado] ?? "fue procesada";
      return (
        `Contigo · la foto de la medicación de las ${p?.horaLocal ?? "hoy"} ${desenlace}. ` +
        `Ver el detalle en la app: ${ENLACE_APP}/cuidador/medicacion`
      );
    },
  },
  MEDICACION_NO_TOMADA: {
    plantilla: "contigo_apoyo_medicacion",
    texto: (n, p) =>
      `Contigo · ${n.toLowerCase()} marcó que no tomó una de sus medicaciones de hoy (${p?.horaLocal ?? "hora indicada"}). ` +
      `Ver en la app: ${ENLACE_APP}/cuidador/medicacion`,
  },
  MEDICACION_SIN_RESPUESTA: {
    plantilla: "contigo_apoyo_medicacion",
    texto: (n, p) =>
      `Contigo · no llegó la foto de la medicación de las ${p?.horaLocal ?? "hoy"}. ` +
      `Si puede, acompáñela a tomarla en la app: ${ENLACE_APP}/paciente/medicacion`,
  },
};

/**
 * Cómo se nombra a la paciente en un canal externo: no se la nombra. Ni el
 * nombre, ni el RUN, ni el identificador del caso salen de la base por
 * WhatsApp — quien recibe el aviso ya sabe a quién acompaña, y quien tome el
 * teléfono prestado no puede vincular el mensaje con una persona.
 */
const SUJETO = "La persona que usted acompaña";

export function redactarMensaje(evento, pacienteId, payload = null) {
  const plantilla = PLANTILLAS[evento];
  if (!plantilla) return null;
  void pacienteId;
  return { plantilla: plantilla.plantilla, texto: plantilla.texto(SUJETO, payload) };
}

/** Destinatario: el teléfono declarado por la persona de apoyo autorizada. */
function destinatario(pacienteId, destinatarioTipo) {
  if (destinatarioTipo !== "cuidador") return null;
  const fila = db
    .prepare(
      "SELECT id, nombre_ficticio, telefono_contacto FROM cuidadores WHERE paciente_id = ? AND activo = 1 AND consentimiento_paciente = 1 AND telefono_contacto IS NOT NULL LIMIT 1",
    )
    .get(pacienteId);
  if (!fila) return null;
  return { id: fila.id, nombre: fila.nombre_ficticio, telefono: descifrar(fila.telefono_contacto) };
}

/**
 * Procesa la bandeja de salida. Cada notificación se resuelve a 'enviada',
 * 'fallida' (se reintenta) o 'cancelada' (falta consentimiento o destinatario:
 * no se reintenta y queda el motivo escrito).
 */
export async function procesarOutbox({ pacienteId = null, limite = 50 } = {}) {
  const pendientes = pacienteId
    ? db
        .prepare("SELECT * FROM notificaciones_outbox WHERE estado = 'pendiente' AND paciente_id = ? ORDER BY creada_en LIMIT ?")
        .all(pacienteId, limite)
    : db
        .prepare("SELECT * FROM notificaciones_outbox WHERE estado = 'pendiente' ORDER BY creada_en LIMIT ?")
        .all(limite);

  const resultado = { enviadas: 0, canceladas: 0, fallidas: 0 };

  for (const n of pendientes) {
    const marcar = (estado, error = null) =>
      db
        .prepare(
          "UPDATE notificaciones_outbox SET estado = ?, intentos = intentos + 1, ultimo_error = ?, enviada_en = CASE WHEN ? = 'enviada' THEN datetime('now') ELSE enviada_en END WHERE id = ?",
        )
        .run(estado, error, estado, n.id);

    if (n.destinatario_tipo === "cuidador" && !consentimientoVigente(n.paciente_id, "contacto_telefonico")) {
      marcar("cancelada", "Sin consentimiento de contacto telefónico vigente.");
      resultado.canceladas += 1;
      continue;
    }

    const mensaje = redactarMensaje(n.evento, n.paciente_id, JSON.parse(n.payload ?? "null"));
    if (!mensaje) {
      marcar("cancelada", `Evento sin plantilla redactada: ${n.evento}.`);
      resultado.canceladas += 1;
      continue;
    }

    const quien = destinatario(n.paciente_id, n.destinatario_tipo);
    if (n.destinatario_tipo === "cuidador" && !quien) {
      marcar("cancelada", "No hay persona de apoyo autorizada con teléfono registrado.");
      resultado.canceladas += 1;
      continue;
    }

    try {
      await enviarWhatsApp(quien, mensaje, n);
      marcar("enviada");
      resultado.enviadas += 1;
    } catch (err) {
      marcar("fallida", String(err.message).slice(0, 300));
      resultado.fallidas += 1;
    }
  }

  return resultado;
}

/**
 * Adaptadores de envío. Cambiar de proveedor es cambiar una variable de
 * entorno: el resto del sistema (eventos, redacción, consentimiento,
 * auditoría) no se entera de cuál está activo.
 */
async function enviarWhatsApp(quien, mensaje, notificacion) {
  const destino = quien?.telefono;

  if (PROVEEDOR === "simulado") {
    console.log(
      `[whatsapp:simulado] → ${destino ?? notificacion.destinatario_tipo}: ${mensaje.texto}`,
    );
    return;
  }

  if (PROVEEDOR === "whatsapp_cloud") {
    const token = requerir("WHATSAPP_TOKEN");
    const numeroId = requerir("WHATSAPP_PHONE_NUMBER_ID");
    const respuesta = await fetch(
      `https://graph.facebook.com/v21.0/${numeroId}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: destino,
          type: "text",
          text: { body: mensaje.texto },
        }),
      },
    );
    if (!respuesta.ok) throw new Error(`Cloud API ${respuesta.status}: ${await respuesta.text()}`);
    return;
  }

  if (PROVEEDOR === "twilio") {
    const sid = requerir("TWILIO_ACCOUNT_SID");
    const token = requerir("TWILIO_AUTH_TOKEN");
    const emisor = requerir("TWILIO_WHATSAPP_FROM");
    const cuerpo = new URLSearchParams({
      From: `whatsapp:${emisor}`,
      To: `whatsapp:${destino}`,
      Body: mensaje.texto,
    });
    const respuesta = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: cuerpo,
      },
    );
    if (!respuesta.ok) throw new Error(`Twilio ${respuesta.status}: ${await respuesta.text()}`);
    return;
  }

  throw new Error(`Proveedor de notificaciones desconocido: ${PROVEEDOR}.`);
}

function requerir(clave) {
  const valor = process.env[clave];
  if (!valor) throw new Error(`Falta la variable de entorno ${clave}.`);
  return valor;
}

/** Enlace click-to-chat: abre WhatsApp con el mensaje escrito, sin API. */
export function enlaceWhatsApp(telefono, texto) {
  const numero = String(telefono ?? "").replace(/[^\d]/g, "");
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

export { PROVEEDOR };
