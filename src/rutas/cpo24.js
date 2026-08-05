import { Router } from "express";
import { db, nuevoId } from "../db.js";
import { auditar } from "../auditoria.js";
import { pacientesVisibles, soloRoles } from "../auth.js";

export const rutasCpo24 = Router();

rutasCpo24.post("/pacientes/:pacienteId/cpo24/intentos", soloRoles("profesional", "admin"), (req, res) => {
  const { pacienteId } = req.params;
  if (!pacientesVisibles(req.usuario).includes(pacienteId) && req.usuario.tipo !== "admin") return res.status(403).json({ error: "Paciente fuera de tu ámbito." });
  const ultimo = db.prepare("SELECT COALESCE(MAX(numero), 0) AS n FROM cpo24_intentos WHERE paciente_id = ?").get(pacienteId).n;
  const numero = ultimo + 1;
  const respondio = req.body?.respondio === true ? 1 : 0;
  const id = nuevoId("CPO");
  db.prepare("INSERT INTO cpo24_intentos (id, paciente_id, numero, respondio, canal, registrado_por, observacion) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, pacienteId, numero, respondio, req.body?.canal ?? "telefonico", req.usuario.id, req.body?.observacion ?? null);
  if (!respondio && numero >= 3) encolar(pacienteId, "cuidador", "CPO24_SIN_RESPUESTA");
  if (!respondio && numero >= 5) encolar(pacienteId, "establecimiento", "CPO24_ESCALAMIENTO_ESTABLECIMIENTO");
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `cpo24/${pacienteId}/${numero}`, req });
  res.status(201).json({ intentoId: id, numero, escalado: !respondio && numero >= 3 });
});

rutasCpo24.get("/pacientes/:pacienteId/cpo24", (req, res) => {
  if (!pacientesVisibles(req.usuario).includes(req.params.pacienteId)) return res.status(403).json({ error: "No autorizado." });
  res.json({ intentos: db.prepare("SELECT * FROM cpo24_intentos WHERE paciente_id = ? ORDER BY numero").all(req.params.pacienteId) });
});

export function encolar(pacienteId, destinatarioTipo, evento) {
  const paciente = db.prepare("SELECT id FROM pacientes WHERE id = ?").get(pacienteId);
  if (!paciente) return null;
  const id = nuevoId("NOT");
  db.prepare("INSERT INTO notificaciones_outbox (id, paciente_id, destinatario_tipo, canal, evento, payload) VALUES (?, ?, ?, 'app', ?, ?)").run(id, pacienteId, destinatarioTipo, evento, JSON.stringify({ pacienteId, evento }));
  return id;
}

export function procesarOutbox() {
  const pendientes = db.prepare("SELECT * FROM notificaciones_outbox WHERE estado = 'pendiente' ORDER BY creada_en").all();
  for (const n of pendientes) db.prepare("UPDATE notificaciones_outbox SET estado = 'enviada', intentos = intentos + 1, enviada_en = datetime('now') WHERE id = ?").run(n.id);
  return pendientes.length;
}
