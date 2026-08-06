import { Router } from "express";
import { db, nuevoId } from "../db.js";
import { auditar } from "../auditoria.js";
import { pacientesVisibles, soloRoles } from "../auth.js";
import {
  PROVEEDOR,
  procesarOutbox as procesarOutboxImpl,
  redactarMensaje,
} from "../notificaciones.js";

export const rutasCpo24 = Router();

rutasCpo24.post("/pacientes/:pacienteId/cpo24/intentos", soloRoles("profesional", "admin"), (req, res) => {
  const { pacienteId } = req.params;
  if (!pacientesVisibles(req.usuario).includes(pacienteId) && req.usuario.tipo !== "admin") return res.status(403).json({ error: "Paciente fuera de tu ámbito." });
  const ultimo = db.prepare("SELECT COALESCE(MAX(numero), 0) AS n FROM cpo24_intentos WHERE paciente_id = ?").get(pacienteId).n;
  const numero = ultimo + 1;
  const respondio = req.body?.respondio === true ? 1 : 0;
  const id = nuevoId("CPO");
  db.prepare("INSERT INTO cpo24_intentos (id, paciente_id, numero, respondio, canal, registrado_por, observacion) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, pacienteId, numero, respondio, req.body?.canal ?? "telefonico", req.usuario.id, req.body?.observacion ?? null);
  if (!respondio && numero === 3) encolar(pacienteId, "cuidador", "CPO24_SIN_RESPUESTA");
  if (!respondio && numero === 5) encolar(pacienteId, "establecimiento", "CPO24_ESCALAMIENTO_ESTABLECIMIENTO");
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `cpo24/${pacienteId}/${numero}`, req });
  res.status(201).json({ intentoId: id, numero, escalado: !respondio && numero >= 3 });
});

rutasCpo24.get("/pacientes/:pacienteId/cpo24", (req, res) => {
  if (!pacientesVisibles(req.usuario).includes(req.params.pacienteId)) return res.status(403).json({ error: "No autorizado." });
  res.json({ intentos: db.prepare("SELECT * FROM cpo24_intentos WHERE paciente_id = ? ORDER BY numero").all(req.params.pacienteId) });
});

/**
 * Encola un aviso. El canal por defecto de la persona de apoyo es WhatsApp
 * (el mismo que el sistema público ya usa con esta población vía CPO-24); el
 * establecimiento se avisa dentro de la app. El envío real y el chequeo de
 * consentimiento ocurren al procesar la bandeja, en notificaciones.js.
 */
export function encolar(pacienteId, destinatarioTipo, evento, payloadExtra = {}) {
  const paciente = db.prepare("SELECT id FROM pacientes WHERE id = ?").get(pacienteId);
  if (!paciente) return null;
  const id = nuevoId("NOT");
  const canal = destinatarioTipo === "cuidador" ? "whatsapp" : "app";
  db.prepare("INSERT INTO notificaciones_outbox (id, paciente_id, destinatario_tipo, canal, evento, payload) VALUES (?, ?, ?, ?, ?, ?)").run(id, pacienteId, destinatarioTipo, canal, evento, JSON.stringify({ pacienteId, evento, ...payloadExtra }));
  return id;
}

export { procesarOutboxImpl as procesarOutbox };

/**
 * La bandeja de avisos del paciente, con el texto exacto que se envía. Se
 * expone para que la persona de apoyo (y el equipo, en la demo) pueda ver qué
 * salió, cuándo y por qué: un aviso cancelado por falta de consentimiento se
 * ve igual que uno enviado.
 */
rutasCpo24.get("/pacientes/:pacienteId/notificaciones", (req, res) => {
  const { pacienteId } = req.params;
  if (!pacientesVisibles(req.usuario).includes(pacienteId)) {
    return res.status(403).json({ error: "No autorizado." });
  }
  const filas = db
    .prepare("SELECT id, canal, destinatario_tipo, evento, estado, intentos, ultimo_error, creada_en, enviada_en FROM notificaciones_outbox WHERE paciente_id = ? ORDER BY creada_en DESC, rowid DESC LIMIT 50")
    .all(pacienteId);
  res.json({
    proveedor: PROVEEDOR,
    notificaciones: filas.map((fila) => ({
      ...fila,
      mensaje: redactarMensaje(fila.evento, pacienteId)?.texto ?? null,
    })),
  });
});

/** Procesa la bandeja del paciente. En producción esto sería un worker. */
rutasCpo24.post("/pacientes/:pacienteId/notificaciones/procesar", async (req, res, next) => {
  try {
    if (!pacientesVisibles(req.usuario).includes(req.params.pacienteId)) {
      return res.status(403).json({ error: "No autorizado." });
    }
    const resultado = await procesarOutboxImpl({ pacienteId: req.params.pacienteId });
    auditar({ usuario: req.usuario, accion: "modificacion", recurso: `notificaciones/${req.params.pacienteId}`, req });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});
