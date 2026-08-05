/**
 * Check-in diario y alertas.
 *
 * El color lo decide el motor determinístico del servidor (motor.js) sobre la
 * matriz clínica — nunca un modelo. El check-in queda documentado en
 * `seguimientos` y, si el color no es verde, se persiste una fila en `alertas`
 * para el circuito del profesional.
 */

import { Router } from "express";
import { db, nuevoId } from "../db.js";
import { auditar } from "../auditoria.js";
import { exigirAccesoAPaciente, pacientesVisibles, soloRoles } from "../auth.js";
import { matriz, evaluar, diaRelativo, preguntasDelDia } from "../motor.js";

export const rutasSeguimiento = Router();

/** Preguntas del día para el paciente (según su fecha de alta real). */
rutasSeguimiento.get(
  "/pacientes/:pacienteId/checkin-hoy",
  exigirAccesoAPaciente,
  (req, res) => {
    const evento = eventoActual(req.params.pacienteId);
    if (!evento?.fecha_alta) {
      return res.status(404).json({ error: "El paciente no tiene un alta registrada." });
    }
    const m = matriz();
    const dia = diaRelativo(evento.fecha_alta);
    res.json({ dia, preguntas: preguntasDelDia(m, dia) });
  },
);

/** Registra un check-in: evalúa, persiste y devuelve la evaluación. */
rutasSeguimiento.post(
  "/pacientes/:pacienteId/checkins",
  exigirAccesoAPaciente,
  (req, res) => {
    const { pacienteId } = req.params;
    const respuestas = req.body?.respuestas;
    if (!respuestas || typeof respuestas !== "object") {
      return res.status(400).json({ error: "Faltan las respuestas del check-in." });
    }
    const evento = eventoActual(pacienteId);
    if (!evento?.fecha_alta) {
      return res.status(404).json({ error: "El paciente no tiene un alta registrada." });
    }

    const m = matriz();
    const dia = diaRelativo(evento.fecha_alta);
    const evaluacion = evaluar(m, respuestas, dia);

    // Mapeo de las respuestas del check-in a las columnas de `seguimientos`.
    const HERIDA = { igual: "normal", mas_roja: "inflamada", liquido: "con_exudado" };
    const MOVILIDAD = { si_solo: "mejorando", si_ayuda: "sin_cambios", no: "empeorando" };
    const ADHERENCIA = { si: "completa", algunos: "parcial", no: "no_toma", dudas: "parcial" };

    const seguimientoId = nuevoId("SEG");
    db.prepare(
      `INSERT INTO seguimientos
         (id, paciente_id, evento_quirurgico_id, dia_postoperatorio,
          contacto_24h_realizado, orientacion_entregada, recomendacion_urgencia,
          dolor_reportado, nauseas, vomitos, fiebre_reportada, confusion_orientacion,
          sangrado, estado_herida, movilidad, alimentacion_hidratacion,
          adherencia_medicamentos, apoyo_cuidador, control_agendado,
          necesidad_derivacion, registrado_por, fuente_dato)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seguimientoId,
      pacienteId,
      evento.id,
      dia,
      respuestas.contacto24h === true ? 1 : 0,
      respuestas.orientacionEntregada === true ? 1 : 0,
      respuestas.recomendacionUrgencia === true ? 1 : 0,
      respuestas.dolor === undefined ? null : Number(respuestas.dolor),
      respuestas.nauseas === true ? 1 : 0,
      respuestas.vomitos === true ? 1 : 0,
      respuestas.fiebre === true ? 1 : 0,
      respuestas.confusion === true ? 1 : 0,
      respuestas.sangrado === true ? 1 : 0,
      HERIDA[respuestas.herida] ?? null,
      MOVILIDAD[respuestas.movilidad] ?? null,
      respuestas.alimentacion ?? null,
      ADHERENCIA[respuestas.medicamentos] ?? null,
      respuestas.apoyoCuidador === true ? 1 : 0,
      respuestas.controlAgendado === true ? 1 : 0,
      evaluacion.color === "rojo" ? 1 : 0,
      req.usuario.tipo === "cuidador" ? "cuidador" : "paciente",
      `checkin_app:${JSON.stringify(respuestas)}`,
    );

    for (const alerta of evaluacion.alertas) {
      db.prepare(
        `INSERT INTO alertas (id, seguimiento_id, paciente_id, nivel, descripcion)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        nuevoId("ALR"),
        seguimientoId,
        pacienteId,
        alerta.senal.color === "rojo" ? "roja" : "amarilla",
        `${alerta.senal.descripcion} — Pregunta: "${alerta.preguntaTexto}" Respuesta: "${alerta.respuestaDada}" (regla ${alerta.reglaId}, fuente: ${alerta.senal.fuente?.institucion ?? "?"})`,
      );
    }

    auditar({
      usuario: req.usuario,
      accion: "escritura",
      recurso: `seguimientos/${seguimientoId}`,
      req,
    });

    res.status(201).json({ seguimientoId, evaluacion });
  },
);

rutasSeguimiento.get("/seguimientos/:seguimientoId", (req, res) => {
  const seguimiento = db.prepare("SELECT * FROM seguimientos WHERE id = ?").get(req.params.seguimientoId);
  if (!seguimiento || !pacientesVisibles(req.usuario).includes(seguimiento.paciente_id)) return res.status(404).json({ error: "Seguimiento no encontrado." });
  res.json({ seguimiento });
});

rutasSeguimiento.post("/seguimientos/:seguimientoId/revisar", soloRoles("profesional"), (req, res) => {
  const seguimiento = db.prepare("SELECT * FROM seguimientos WHERE id = ?").get(req.params.seguimientoId);
  if (!seguimiento || !pacientesVisibles(req.usuario).includes(seguimiento.paciente_id)) return res.status(404).json({ error: "Seguimiento no encontrado." });
  db.prepare("UPDATE seguimientos SET revision_profesional = 1 WHERE id = ?").run(seguimiento.id);
  auditar({ usuario: req.usuario, accion: "modificacion", recurso: `seguimientos/${seguimiento.id}`, campo: "revision_profesional", valorAnterior: seguimiento.revision_profesional, valorNuevo: 1, req });
  res.json({ ok: true });
});

/** Alertas visibles según el rol (profesional: su establecimiento). */
rutasSeguimiento.get("/alertas", (req, res) => {
  const visibles = pacientesVisibles(req.usuario);
  if (visibles.length === 0) return res.json({ alertas: [] });
  const marcadores = visibles.map(() => "?").join(",");
  const alertas = db
    .prepare(
      `SELECT a.*, p.nombre_ficticio
       FROM alertas a JOIN pacientes p ON p.id = a.paciente_id
       WHERE a.paciente_id IN (${marcadores})
       ORDER BY CASE a.estado WHEN 'pendiente' THEN 0 ELSE 1 END,
                a.fecha_creacion DESC
       LIMIT 100`,
    )
    .all(...visibles);
  res.json({ alertas });
});

/** Solo el profesional atiende o escala una alerta (matriz de permisos §4.2). */
rutasSeguimiento.post(
  "/alertas/:alertaId/atender",
  soloRoles("profesional"),
  (req, res) => {
    const alerta = db
      .prepare("SELECT * FROM alertas WHERE id = ?")
      .get(req.params.alertaId);
    if (!alerta) return res.status(404).json({ error: "Alerta no encontrada." });
    if (!pacientesVisibles(req.usuario).includes(alerta.paciente_id)) {
      return res.status(403).json({ error: "No tienes autorización sobre este paciente." });
    }
    const estado = req.body?.estado ?? "resuelta";
    if (!["en_revision", "resuelta", "escalada"].includes(estado)) {
      return res.status(400).json({ error: "Estado inválido." });
    }
    const accion = String(req.body?.accionTomada ?? "").trim();
    if (!accion) {
      return res
        .status(400)
        .json({ error: "Debe documentarse la acción tomada (ninguna alerta se cierra sin intervención documentada)." });
    }
    db.prepare(
      `UPDATE alertas SET estado = ?, accion_tomada = ?, atendida_por = ?, fecha_atencion = datetime('now')
       WHERE id = ?`,
    ).run(estado, accion, req.usuario.profesionalId, alerta.id);
    auditar({
      usuario: req.usuario,
      accion: "modificacion",
      recurso: `alertas/${alerta.id}`,
      campo: "estado",
      valorAnterior: alerta.estado,
      valorNuevo: estado,
      req,
    });
    res.json({ ok: true });
  },
);

function eventoActual(pacienteId) {
  return db
    .prepare(
      "SELECT * FROM eventos_quirurgicos WHERE paciente_id = ? ORDER BY fecha_alta DESC LIMIT 1",
    )
    .get(pacienteId);
}
