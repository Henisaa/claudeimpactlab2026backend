import { Router } from "express";
import { db, nuevoId } from "../db.js";
import { auditar } from "../auditoria.js";
import { exigirAccesoAPaciente, pacientesVisibles, soloRoles } from "../auth.js";

export const rutasCrud = Router();

rutasCrud.get("/pacientes/:pacienteId/cuidadores", exigirAccesoAPaciente, (req, res) => {
  res.json({ cuidadores: db.prepare("SELECT * FROM cuidadores WHERE paciente_id = ? AND activo = 1").all(req.params.pacienteId) });
});

rutasCrud.post("/pacientes/:pacienteId/cuidadores", exigirAccesoAPaciente, (req, res) => {
  if (req.usuario.tipo !== "paciente") return res.status(403).json({ error: "Solo el paciente puede agregar cuidadores." });
  const { nombreFicticio, relacion, permisos = { ver_expediente: true, registrar_sintomas: true } } = req.body ?? {};
  if (!nombreFicticio || !relacion) return res.status(400).json({ error: "nombreFicticio y relacion son obligatorios." });
  const id = nuevoId("CUI");
  db.prepare(`INSERT INTO cuidadores (id, paciente_id, nombre_ficticio, relacion, permisos, consentimiento_paciente, fecha_autorizacion)
              VALUES (?, ?, ?, ?, ?, 1, datetime('now'))`).run(id, req.params.pacienteId, nombreFicticio, relacion, JSON.stringify(permisos));
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `cuidadores/${id}`, req });
  res.status(201).json({ cuidadorId: id });
});

rutasCrud.delete("/cuidadores/:cuidadorId", (req, res) => {
  const cuidador = db.prepare("SELECT * FROM cuidadores WHERE id = ?").get(req.params.cuidadorId);
  if (!cuidador) return res.status(404).json({ error: "Cuidador no encontrado." });
  if (!pacientesVisibles(req.usuario).includes(cuidador.paciente_id) || req.usuario.tipo !== "paciente") return res.status(403).json({ error: "No autorizado." });
  db.prepare("UPDATE cuidadores SET activo = 0, consentimiento_paciente = 0 WHERE id = ?").run(cuidador.id);
  auditar({ usuario: req.usuario, accion: "eliminacion", recurso: `cuidadores/${cuidador.id}`, campo: "activo", valorAnterior: 1, valorNuevo: 0, req });
  res.json({ ok: true });
});

rutasCrud.get("/pacientes/:pacienteId/eventos", exigirAccesoAPaciente, (req, res) => {
  res.json({ eventos: db.prepare("SELECT * FROM eventos_quirurgicos WHERE paciente_id = ? ORDER BY fecha_alta DESC").all(req.params.pacienteId) });
});

rutasCrud.post("/pacientes/:pacienteId/eventos", exigirAccesoAPaciente, soloRoles("profesional"), (req, res) => {
  const body = req.body ?? {};
  if (!body.fechaAlta || !body.modalidad) return res.status(400).json({ error: "fechaAlta y modalidad son obligatorios." });
  const eventoId = nuevoId("EVT");
  const establecimiento = db.prepare("SELECT establecimiento_id FROM profesionales WHERE id = ? AND activo = 1").get(req.usuario.profesionalId);
  db.prepare(`INSERT INTO eventos_quirurgicos (id, paciente_id, fecha_cirugia, modalidad, establecimiento_id, servicio_clinico, anestesia, fecha_ingreso, fecha_alta, dias_estadia, condicion_egreso, profesional_cirujano_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(eventoId, req.params.pacienteId, body.fechaCirugia ?? null, body.modalidad, body.establecimientoId ?? establecimiento?.establecimiento_id ?? null, body.servicioClinico ?? null, body.anestesia ?? null, body.fechaIngreso ?? null, body.fechaAlta, body.diasEstadia ?? null, body.condicionEgreso ?? null, req.usuario.profesionalId);
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `eventos/${eventoId}`, req });
  res.status(201).json({ eventoId });
});

rutasCrud.patch("/eventos/:eventoId", soloRoles("profesional"), (req, res) => {
  const evento = db.prepare("SELECT * FROM eventos_quirurgicos WHERE id = ?").get(req.params.eventoId);
  if (!evento) return res.status(404).json({ error: "Evento no encontrado." });
  if (!pacientesVisibles(req.usuario).includes(evento.paciente_id)) return res.status(403).json({ error: "Paciente fuera de tu establecimiento." });
  const permitidos = ["fecha_cirugia", "fecha_alta", "condicion_egreso", "dias_estadia", "servicio_clinico", "anestesia"];
  const cambios = Object.fromEntries(permitidos.filter((k) => req.body?.[k] !== undefined).map((k) => [k, req.body[k]]));
  for (const [campo, valor] of Object.entries(cambios)) {
    db.prepare(`UPDATE eventos_quirurgicos SET ${campo} = ? WHERE id = ?`).run(valor, evento.id);
    auditar({ usuario: req.usuario, accion: "modificacion", recurso: `eventos/${evento.id}`, campo, valorAnterior: evento[campo], valorNuevo: valor, req });
  }
  res.json({ ok: true });
});

rutasCrud.get("/eventos/:eventoId/indicaciones", (req, res) => {
  const evento = db.prepare("SELECT * FROM eventos_quirurgicos WHERE id = ?").get(req.params.eventoId);
  if (!evento || !pacientesVisibles(req.usuario).includes(evento.paciente_id)) return res.status(403).json({ error: "No autorizado." });
  res.json({ indicaciones: db.prepare("SELECT * FROM indicaciones_alta WHERE evento_quirurgico_id = ? ORDER BY fecha_indicacion DESC").all(evento.id) });
});

rutasCrud.post("/eventos/:eventoId/indicaciones", soloRoles("profesional"), guardarIndicacion);
rutasCrud.patch("/indicaciones/:indicacionId", soloRoles("profesional"), (req, res) => {
  const indicacion = db.prepare(`SELECT i.*, e.paciente_id FROM indicaciones_alta i JOIN eventos_quirurgicos e ON e.id = i.evento_quirurgico_id WHERE i.id = ?`).get(req.params.indicacionId);
  if (!indicacion || !pacientesVisibles(req.usuario).includes(indicacion.paciente_id)) return res.status(403).json({ error: "No autorizado." });
  const fields = ["medicamentos", "dosis_indicada", "frecuencia_indicada", "duracion_indicada", "curacion_herida", "restricciones_fisicas", "alimentacion", "signos_alarma", "canal_contacto", "fecha_proximo_control"];
  for (const campo of fields) if (req.body?.[campo] !== undefined) {
    db.prepare(`UPDATE indicaciones_alta SET ${campo} = ? WHERE id = ?`).run(typeof req.body[campo] === "object" ? JSON.stringify(req.body[campo]) : req.body[campo], indicacion.id);
    auditar({ usuario: req.usuario, accion: "modificacion", recurso: `indicaciones/${indicacion.id}`, campo, valorAnterior: indicacion[campo], valorNuevo: req.body[campo], req });
  }
  res.json({ ok: true });
});

function guardarIndicacion(req, res) {
  const evento = db.prepare("SELECT * FROM eventos_quirurgicos WHERE id = ?").get(req.params.eventoId);
  if (!evento || !pacientesVisibles(req.usuario).includes(evento.paciente_id)) return res.status(403).json({ error: "Evento fuera de tu establecimiento." });
  const b = req.body ?? {};
  const id = nuevoId("IND");
  db.prepare(`INSERT INTO indicaciones_alta (id, evento_quirurgico_id, medicamentos, dosis_indicada, frecuencia_indicada, duracion_indicada, curacion_herida, restricciones_fisicas, alimentacion, signos_alarma, canal_contacto, fecha_proximo_control, fuente, profesional_indica_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, evento.id, JSON.stringify(b.medicamentos ?? []), b.dosisIndicada ?? null, b.frecuenciaIndicada ?? null, b.duracionIndicada ?? null, b.curacionHerida ?? null, b.restriccionesFisicas ?? null, b.alimentacion ?? null, JSON.stringify(b.signosAlarma ?? []), b.canalContacto ?? null, b.fechaProximoControl ?? null, b.fuente ?? "indicación profesional", req.usuario.profesionalId);
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `indicaciones/${id}`, req });
  res.status(201).json({ indicacionId: id });
}
