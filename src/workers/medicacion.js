/**
 * Worker de medicación (prototipo).
 *
 * En un prototipo de pitch no hace falta una cola externa: un proceso con
 * setInterval dentro del servidor (solo en DEMO_MODE) alcanza para mostrar el
 * flujo completo. En producción esto migraría a un worker separado con
 * PostgreSQL + Redis/BullMQ (ver Plan_Implementacion_Medicacion_Fotografia_WhatsApp.md).
 *
 * El tick es idempotente por clave (plan + fecha + hora): el mismo tick
 * ejecutado dos veces no duplica tomas ni recordatorios.
 */

import { db, nuevoId } from "../db.js";
import { encolar } from "../rutas/cpo24.js";
import { hoyEnZona, momentoUtcDesdeHoraLocal, formatoUtc } from "../medicacion/horarios.js";

/** Crea la toma de HOY para cada plan activo con horario explícito. */
export function materializarTomas(planId = null) {
  const planes = planId
    ? [db.prepare("SELECT * FROM planes_medicacion WHERE id = ?").get(planId)]
    : db.prepare("SELECT * FROM planes_medicacion WHERE estado = 'activo'").all();

  let creadas = 0;
  for (const plan of planes) {
    if (!plan?.horario_local) continue;
    const hoy = hoyEnZona(plan.zona_horaria);
    const clave = `${plan.id}-${hoy.fechaLocal}-${plan.horario_local}`;
    if (db.prepare("SELECT 1 FROM tomas_programadas WHERE clave_idempotencia = ?").get(clave)) continue;

    const inicio = momentoUtcDesdeHoraLocal(plan.zona_horaria, hoy.fechaLocal, plan.horario_local);
    const ventana = (plan.ventana_minutos ?? 15) * 60_000;
    db.prepare(
      `INSERT INTO tomas_programadas
         (id, plan_medicacion_id, programada_para_utc, fecha_local, hora_local, zona_horaria,
          ventana_inicio, ventana_fin, clave_idempotencia)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nuevoId("TOM"),
      plan.id,
      formatoUtc(inicio),
      hoy.fechaLocal,
      plan.horario_local,
      plan.zona_horaria,
      formatoUtc(new Date(inicio.getTime() - ventana)),
      formatoUtc(new Date(inicio.getTime() + ventana)),
      clave,
    );
    creadas += 1;
  }
  return creadas;
}

/**
 * Un ciclo del worker:
 *  1. materializa las tomas de hoy;
 *  2. enciende recordatorios cuando llega la hora (una sola vez por toma);
 *  3. marca como sin_respuesta las tomas cuya ventana ya terminó.
 */
export function tickMedicacion() {
  const ahora = formatoUtc(new Date());
  const creadas = materializarTomas();

  const porRecordar = db
    .prepare(
      `SELECT t.id, t.horario_local, p.paciente_id
       FROM tomas_programadas t
       JOIN planes_medicacion p ON p.id = t.plan_medicacion_id
       WHERE t.estado = 'pendiente' AND t.programada_para_utc <= ? AND t.intentos_recordatorio = 0`,
    )
    .all(ahora);
  let recordatorios = 0;
  for (const t of porRecordar) {
    db.prepare(
      "UPDATE tomas_programadas SET estado = 'recordatorio_enviado', intentos_recordatorio = intentos_recordatorio + 1 WHERE id = ?",
    ).run(t.id);
    encolar(t.paciente_id, "cuidador", "RECORDATORIO_MEDICACION", { horaLocal: t.horario_local });
    recordatorios += 1;
  }

  const vencidas = db
    .prepare(
      `SELECT t.id, t.horario_local, p.paciente_id
       FROM tomas_programadas t
       JOIN planes_medicacion p ON p.id = t.plan_medicacion_id
       WHERE t.estado IN ('pendiente','recordatorio_enviado') AND t.ventana_fin < ?`,
    )
    .all(ahora);
  let sinRespuesta = 0;
  for (const t of vencidas) {
    db.prepare("UPDATE tomas_programadas SET estado = 'sin_respuesta' WHERE id = ?").run(t.id);
    encolar(t.paciente_id, "cuidador", "MEDICACION_SIN_RESPUESTA", { horaLocal: t.horario_local });
    sinRespuesta += 1;
  }

  return { creadas, recordatorios, sinRespuesta };
}

let timer = null;

export function arrancarWorkerMedicacion(intervaloMs = 30_000) {
  detenerWorkerMedicacion();
  timer = setInterval(() => {
    try {
      tickMedicacion();
    } catch (err) {
      console.error(`[medicacion] tick falló: ${err.message}`);
    }
  }, intervaloMs);
  timer.unref?.();
  try {
    tickMedicacion();
  } catch (err) {
    console.error(`[medicacion] tick inicial falló: ${err.message}`);
  }
  console.log(`[medicacion] worker iniciado cada ${intervaloMs} ms`);
  return timer;
}

export function detenerWorkerMedicacion() {
  if (timer) clearInterval(timer);
  timer = null;
}
