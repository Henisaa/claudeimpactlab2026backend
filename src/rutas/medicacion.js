/**
 * Medicación fotografiada y verificada — prototipo para el pitch.
 *
 * Flujo: plan aprobado → toma esperada → foto del envase → Claude lee el
 * texto visible → comparador determinístico contra el plan → resultado →
 * aviso por WhatsApp a la persona de apoyo.
 *
 * Guardrails del prototipo (idénticos a los del plan completo):
 *   - el horario lo escribe/aprueba un profesional, el sistema no lo infiere;
 *   - Claude no decide si el medicamento es el correcto (comparar.js lo hace);
 *   - la foto es evidencia de que se fotografía un envase, no de que se ingirió:
 *     la declaración "lo tomé" es un dato aparte (tomas_programadas.declaracion);
 *   - toda verificación lleva requiere_revision_profesional = true.
 */

import { Router } from "express";
import multer from "multer";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { db, nuevoId, RUTA_UPLOADS } from "../db.js";
import { auditar } from "../auditoria.js";
import { exigirAccesoAPaciente, consentimientoVigente, soloRoles, pacientesVisibles } from "../auth.js";
import { extraerMedicamento } from "../claude.js";
import { compararMedicamento } from "../medicacion/comparar.js";
import { hoyEnZona, formatoUtc } from "../medicacion/horarios.js";
import { cifrar, descifrar } from "../seguridad.js";
import { encolar } from "./cpo24.js";
import { materializarTomas, tickMedicacion } from "../workers/medicacion.js";

export const rutasMedicacion = Router();

const DEMO = process.env.DEMO_MODE === "true";

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});
const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const RUTA_EVIDENCIAS = path.join(RUTA_UPLOADS, "medicacion");
mkdirSync(RUTA_EVIDENCIAS, { recursive: true });

// --- Helpers ----------------------------------------------------------------

const CAMPOS_PLAN = ["medicamento_nombre", "concentracion", "frecuencia_texto", "duracion_texto", "cita_original"];

function descifrarPlan(plan) {
  if (!plan) return plan;
  const copia = { ...plan };
  for (const campo of CAMPOS_PLAN) {
    if (copia[campo] !== null && copia[campo] !== undefined) copia[campo] = descifrar(copia[campo]);
  }
  return copia;
}

function tomaPorId(id) {
  const fila = db
    .prepare(
      `SELECT t.*, p.paciente_id, p.medicamento_nombre, p.concentracion, p.horario_local,
              p.frecuencia_texto, p.duracion_texto, p.zona_horaria, p.ventana_minutos
       FROM tomas_programadas t
       JOIN planes_medicacion p ON p.id = t.plan_medicacion_id
       WHERE t.id = ?`,
    )
    .get(id);
  return fila ? descifrarPlan(fila) : null;
}

/** El :tomaId de la ruta debe existir y pertenecer a un paciente visible. */
function exigirAccesoAToma(req, res, next) {
  const toma = tomaPorId(req.params.tomaId);
  if (!toma) return res.status(404).json({ error: "Toma no encontrada." });
  if (!pacientesVisibles(req.usuario).includes(toma.paciente_id)) {
    return res.status(403).json({ error: "No tienes autorización sobre este paciente." });
  }
  req.toma = toma;
  next();
}

// --- Planes -----------------------------------------------------------------

/** Lista los planes de medicación del paciente (cifrados en la base, claros en API). */
rutasMedicacion.get("/pacientes/:pacienteId/medicacion/planes", exigirAccesoAPaciente, (req, res) => {
  const planes = db
    .prepare("SELECT * FROM planes_medicacion WHERE paciente_id = ? ORDER BY creado_en DESC")
    .all(req.params.pacienteId)
    .map(descifrarPlan);
  res.json({ planes });
});

/** Solo un profesional crea un plan. Queda pendiente de aprobación (no activo). */
rutasMedicacion.post("/pacientes/:pacienteId/medicacion/planes", soloRoles("profesional"), (req, res) => {
  const { pacienteId } = req.params;
  if (!pacientesVisibles(req.usuario).includes(pacienteId)) {
    return res.status(403).json({ error: "Paciente fuera de tu ámbito." });
  }
  const { medicamentoNombre, concentracion, frecuenciaTexto, duracionTexto, horarioLocal, citaOriginal } = req.body ?? {};
  if (!medicamentoNombre?.trim()) return res.status(400).json({ error: "El nombre del medicamento es obligatorio." });
  if (horarioLocal && !/^\d{1,2}:\d{2}$/.test(horarioLocal)) {
    return res.status(400).json({ error: "El horario debe tener el formato HH:MM (ej. 10:00)." });
  }
  const id = nuevoId("PLN");
  db.prepare(
    `INSERT INTO planes_medicacion
       (id, paciente_id, medicamento_nombre, concentracion, frecuencia_texto, duracion_texto,
        horario_local, cita_original, estado)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente_revision')`,
  ).run(
    id, pacienteId,
    cifrar(medicamentoNombre.trim()),
    concentracion ? cifrar(String(concentracion)) : null,
    frecuenciaTexto ? cifrar(String(frecuenciaTexto)) : null,
    duracionTexto ? cifrar(String(duracionTexto)) : null,
    horarioLocal ?? null,
    citaOriginal ? cifrar(String(citaOriginal)) : null,
  );
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `medicacion/planes/${id}`, req });
  res.status(201).json({ plan: descifrarPlan(db.prepare("SELECT * FROM planes_medicacion WHERE id = ?").get(id)) });
});

/** Aprobar activa el plan y materializa la toma de hoy (funciona para la demo en vivo). */
rutasMedicacion.post("/medicacion/planes/:planId/aprobar", soloRoles("profesional"), (req, res) => {
  const plan = db.prepare("SELECT * FROM planes_medicacion WHERE id = ?").get(req.params.planId);
  if (!plan) return res.status(404).json({ error: "Plan no encontrado." });
  if (!plan.horario_local) {
    return res.status(400).json({ error: "El plan necesita un horario explícito antes de activarse." });
  }
  db.prepare(
    "UPDATE planes_medicacion SET estado = 'activo', aprobado_por = ?, aprobado_en = datetime('now') WHERE id = ?",
  ).run(req.usuario.profesionalId, plan.id);
  const creadas = materializarTomas(plan.id);
  auditar({ usuario: req.usuario, accion: "modificacion", recurso: `medicacion/planes/${plan.id}`, req });
  res.json({ ok: true, tomasCreadas: creadas });
});

// --- Tomas de hoy -----------------------------------------------------------

/** El "hoy" del paciente: planes activos y tomas con su verificación. */
rutasMedicacion.get("/pacientes/:pacienteId/medicacion/hoy", exigirAccesoAPaciente, (req, res) => {
  const { pacienteId } = req.params;
  const planes = db
    .prepare("SELECT * FROM planes_medicacion WHERE paciente_id = ? ORDER BY horario_local")
    .all(pacienteId)
    .map(descifrarPlan);

  const tomas = db
    .prepare(
      `SELECT t.id, t.plan_medicacion_id, t.programada_para_utc, t.fecha_local, t.hora_local,
              t.estado, t.ventana_inicio, t.ventana_fin, t.intentos_recordatorio, t.declaracion,
              p.medicamento_nombre, p.concentracion, p.horario_local, p.frecuencia_texto, p.duracion_texto
       FROM tomas_programadas t
       JOIN planes_medicacion p ON p.id = t.plan_medicacion_id
       WHERE p.paciente_id = ?
       ORDER BY t.programada_para_utc DESC
       LIMIT 20`,
    )
    .all(pacienteId)
    .map(descifrarPlan)
    .map((t) => {
      const evidencia = db
        .prepare("SELECT id, capturada_en, estado_procesamiento FROM evidencias_medicacion WHERE toma_programada_id = ? ORDER BY capturada_en DESC LIMIT 1")
        .get(t.id);
      const verificacion = evidencia
        ? db
            .prepare(
              "SELECT id, nombre_observado, concentracion_observada, texto_original_observado, confianza_vision, resultado_comparacion, motivo, requiere_revision_profesional, creada_en FROM verificaciones_medicacion WHERE evidencia_id = ? ORDER BY creada_en DESC LIMIT 1",
            )
            .get(evidencia.id)
        : null;
      return { ...t, evidencia: evidencia ?? null, verificacion };
    });

  res.json({ planes, tomas });
});

/**
 * Demo: crea una toma "ahora" del primer plan activo. Permite que el pitch
 * funcione a cualquier hora del día, sin esperar a las 10:00. Solo existe en
 * DEMO_MODE.
 */
rutasMedicacion.post("/pacientes/:pacienteId/medicacion/demo/toma-hoy", exigirAccesoAPaciente, (req, res) => {
  if (!DEMO) return res.status(404).json({ error: "Ruta solo disponible en modo demo." });
  const plan = db
    .prepare("SELECT * FROM planes_medicacion WHERE paciente_id = ? AND estado = 'activo' ORDER BY horario_local LIMIT 1")
    .get(req.params.pacienteId);
  if (!plan) return res.status(409).json({ error: "No hay plan de medicación activo para este paciente." });

  const ahora = new Date();
  const hoy = hoyEnZona(plan.zona_horaria);
  const ventana = (plan.ventana_minutos ?? 15) * 60_000;
  const id = nuevoId("TOM");
  const clave = `${plan.id}-demo-${Date.now()}`;
  db.prepare(
    `INSERT INTO tomas_programadas
       (id, plan_medicacion_id, programada_para_utc, fecha_local, hora_local, zona_horaria,
        ventana_inicio, ventana_fin, clave_idempotencia)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, plan.id, formatoUtc(ahora), hoy.fechaLocal, hoy.horaLocal, plan.zona_horaria,
    formatoUtc(new Date(ahora.getTime() - ventana)),
    formatoUtc(new Date(ahora.getTime() + ventana)),
    clave,
  );
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `medicacion/demo/${id}`, req });
  res.status(201).json({ toma: tomaPorId(id) });
});

// --- Foto y verificación ----------------------------------------------------

/**
 * La foto del envase. Flujo completo: consentimiento → archivo cifrado →
 * Claude lee el texto → comparador determinístico → outbox de WhatsApp.
 */
rutasMedicacion.post(
  "/medicacion/tomas/:tomaId/foto",
  exigirAccesoAToma,
  subida.single("imagen"),
  async (req, res, next) => {
    try {
      const toma = req.toma;
      if (!consentimientoVigente(toma.paciente_id, "uso_ia")) {
        return res.status(403).json({ error: 'Falta el consentimiento "uso_ia" del paciente.' });
      }
      if (!DEMO) {
        const ahoraUtc = formatoUtc(new Date());
        if (toma.ventana_inicio && toma.ventana_inicio > ahoraUtc) {
          return res.status(409).json({ error: "La toma todavía no está dentro de su ventana." });
        }
        if (toma.ventana_fin && toma.ventana_fin < ahoraUtc) {
          return res.status(409).json({ error: "La ventana de esta toma ya terminó." });
        }
      }

      const archivo = req.file;
      if (!archivo) return res.status(400).json({ error: "Se requiere una fotografía." });
      if (!TIPOS_IMAGEN.includes(archivo.mimetype)) {
        return res.status(400).json({ error: `Formato no aceptado: ${archivo.mimetype}` });
      }

      const evidenciaId = nuevoId("EVI");
      const ruta = path.join(RUTA_EVIDENCIAS, `${evidenciaId}.bin`);
      const hash = createHash("sha256").update(archivo.buffer).digest("hex");
      // Se cifra como el resto de los archivos del sistema (AES-256-GCM).
      writeFileSync(ruta, Buffer.from(cifrar(archivo.buffer.toString("base64")), "utf8"));

      db.prepare(
        "INSERT INTO evidencias_medicacion (id, toma_programada_id, ruta_archivo_cifrado, hash_archivo, capturada_por) VALUES (?, ?, ?, ?, ?)",
      ).run(evidenciaId, toma.id, ruta, hash, req.usuario.id);

      // Claude lee lo visible; en modo MOCK el resultado es determinístico.
      const { borrador: lectura } = await extraerMedicamento(
        [{ base64: archivo.buffer.toString("base64"), mediaType: archivo.mimetype }],
        { demoResultado: DEMO ? req.body?.demoResultado ?? null : null },
      );
      const observado = lectura?.medicamento_observado ?? {};

      const plan = {
        medicamento_nombre: toma.medicamento_nombre,
        concentracion: toma.concentracion,
      };
      const comparacion = compararMedicamento(plan, observado);

      const verifId = nuevoId("VER");
      db.prepare(
        `INSERT INTO verificaciones_medicacion
           (id, evidencia_id, nombre_observado, concentracion_observada, texto_original_observado,
            confianza_vision, resultado_comparacion, motivo, requiere_revision_profesional)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        verifId, evidenciaId,
        observado.nombre?.valor ?? null,
        observado.concentracion?.valor ?? null,
        observado.nombre?.texto_original ?? null,
        observado.nombre?.confianza ?? lectura?.calidad_imagen ?? null,
        comparacion.resultado,
        comparacion.motivo,
      );
      db.prepare(
        "UPDATE tomas_programadas SET estado = ? WHERE id = ?",
      ).run(comparacion.resultado, toma.id);
      db.prepare(
        "UPDATE evidencias_medicacion SET estado_procesamiento = 'verificada' WHERE id = ?",
      ).run(evidenciaId);

      // La persona de apoyo se entera por WhatsApp sin datos clínicos en el mensaje.
      encolar(toma.paciente_id, "cuidador", "MEDICACION_VERIFICADA", {
        resultado: comparacion.resultado,
        horaLocal: toma.horario_local,
      });

      auditar({
        usuario: req.usuario,
        accion: "escritura",
        recurso: `medicacion/tomas/${toma.id}/foto`,
        req,
      });

      res.status(201).json({
        toma: tomaPorId(toma.id),
        verificacion: db.prepare("SELECT * FROM verificaciones_medicacion WHERE id = ?").get(verifId),
      });
    } catch (err) {
      next(err);
    }
  },
);

/** La foto demuestra que se fotografía un envase; la declaración es un dato aparte. */
rutasMedicacion.post("/medicacion/tomas/:tomaId/confirmar", exigirAccesoAToma, (req, res) => {
  const toma = req.toma;
  const declaracion = req.body?.declaracion;
  if (!["tomada", "no_tomada"].includes(declaracion)) {
    return res.status(400).json({ error: "La declaración debe ser 'tomada' o 'no_tomada'." });
  }
  db.prepare("UPDATE tomas_programadas SET declaracion = ? WHERE id = ?").run(declaracion, toma.id);
  if (declaracion === "no_tomada") {
    encolar(toma.paciente_id, "cuidador", "MEDICACION_NO_TOMADA", { horaLocal: toma.horario_local });
  }
  auditar({ usuario: req.usuario, accion: "modificacion", recurso: `medicacion/tomas/${toma.id}/declaracion`, req });
  res.json({ ok: true, toma: tomaPorId(toma.id) });
});

/** Disparo manual del worker (demo): materializa, recuerda y cierra ventanas. */
rutasMedicacion.post("/admin/medicacion/tick", soloRoles("admin"), (req, res) => {
  const resultado = tickMedicacion();
  auditar({ usuario: req.usuario, accion: "modificacion", recurso: "medicacion/tick", req });
  res.json(resultado);
});
