/**
 * Visitas domiciliarias de la enfermera particular.
 *
 * El aporte de esta profesional al seguimiento es concreto: fija la fecha en
 * que va a ir a la casa. Nada de esto lo decide el sistema — la agenda la
 * escribe ella — y el paciente y su persona de apoyo la ven en su propia
 * pantalla, sin tener que llamar para preguntar "¿cuándo viene?".
 */

import { Router } from "express";
import { db, nuevoId } from "../db.js";
import { auditar } from "../auditoria.js";
import { exigirAccesoAPaciente, pacientesVisibles, soloRoles } from "../auth.js";
import { descifrar } from "../seguridad.js";
import { encolar } from "./cpo24.js";

export const rutasVisitas = Router();

/** La agenda de la profesional: sus pacientes con la próxima visita de cada uno. */
rutasVisitas.get("/profesional/agenda", soloRoles("profesional"), (req, res) => {
  const visibles = pacientesVisibles(req.usuario);
  if (visibles.length === 0) return res.json({ pacientes: [] });

  const marcadores = visibles.map(() => "?").join(",");
  const pacientes = db
    .prepare(`SELECT id, nombre_ficticio, rango_edad, comuna_ficticia FROM pacientes WHERE id IN (${marcadores})`)
    .all(...visibles)
    .map((p) => ({
      ...p,
      nombre_ficticio: descifrar(p.nombre_ficticio),
      comuna_ficticia: descifrar(p.comuna_ficticia),
      visitas: db
        .prepare(
          "SELECT id, fecha, hora, motivo, estado FROM visitas_domiciliarias WHERE paciente_id = ? ORDER BY fecha, hora",
        )
        .all(p.id),
    }));

  auditar({ usuario: req.usuario, accion: "lectura", recurso: "profesional/agenda", req });
  res.json({ pacientes });
});

/** Agendar una visita. Solo la profesional; la fecha la escribe ella. */
rutasVisitas.post("/pacientes/:pacienteId/visitas", soloRoles("profesional"), (req, res) => {
  const { pacienteId } = req.params;
  if (!pacientesVisibles(req.usuario).includes(pacienteId)) {
    return res.status(403).json({ error: "Paciente fuera de tu ámbito." });
  }
  const { fecha, hora, motivo } = req.body ?? {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha ?? ""))) {
    return res.status(400).json({ error: "La fecha debe tener el formato AAAA-MM-DD." });
  }
  if (!/^\d{1,2}:\d{2}$/.test(String(hora ?? ""))) {
    return res.status(400).json({ error: "La hora debe tener el formato HH:MM." });
  }

  const id = nuevoId("VIS");
  db.prepare(
    "INSERT INTO visitas_domiciliarias (id, paciente_id, profesional_id, fecha, hora, motivo) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, pacienteId, req.usuario.profesionalId ?? null, fecha, hora, motivo?.trim() || null);

  // La persona de apoyo se entera por WhatsApp: fecha y hora, sin dato clínico.
  encolar(pacienteId, "cuidador", "VISITA_AGENDADA", { fecha, hora });

  auditar({ usuario: req.usuario, accion: "escritura", recurso: `visitas/${id}`, req });
  res.status(201).json({ visita: db.prepare("SELECT * FROM visitas_domiciliarias WHERE id = ?").get(id) });
});

/** Marcar realizada o cancelada. */
rutasVisitas.patch("/visitas/:visitaId", soloRoles("profesional"), (req, res) => {
  const visita = db.prepare("SELECT * FROM visitas_domiciliarias WHERE id = ?").get(req.params.visitaId);
  if (!visita) return res.status(404).json({ error: "Visita no encontrada." });
  if (!pacientesVisibles(req.usuario).includes(visita.paciente_id)) {
    return res.status(403).json({ error: "Paciente fuera de tu ámbito." });
  }
  const { estado } = req.body ?? {};
  if (!["programada", "realizada", "cancelada"].includes(estado)) {
    return res.status(400).json({ error: "Estado inválido." });
  }
  db.prepare("UPDATE visitas_domiciliarias SET estado = ? WHERE id = ?").run(estado, visita.id);
  auditar({ usuario: req.usuario, accion: "modificacion", recurso: `visitas/${visita.id}`, req });
  res.json({ ok: true });
});

/** Lo que ve el paciente (o quien lo acompaña): sus visitas programadas. */
rutasVisitas.get("/pacientes/:pacienteId/visitas", exigirAccesoAPaciente, (req, res) => {
  const visitas = db
    .prepare(
      `SELECT v.id, v.fecha, v.hora, v.motivo, v.estado, p.nombre_profesional, p.rol
       FROM visitas_domiciliarias v
       LEFT JOIN profesionales p ON p.id = v.profesional_id
       WHERE v.paciente_id = ? AND v.estado != 'cancelada'
       ORDER BY v.fecha, v.hora`,
    )
    .all(req.params.pacienteId);
  res.json({ visitas });
});
