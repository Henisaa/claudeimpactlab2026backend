/**
 * El baúl de la persona: expediente compuesto, subida y confirmación de
 * documentos fotografiados, y la pregunta RAG.
 *
 * Flujo de un documento:
 *   foto → POST /pacientes/:id/documentos   (Claude extrae; queda BORRADOR)
 *        → POST /documentos/:id/confirmar   (una persona confirma contra el papel)
 *        → recién ahí los campos se indexan en el RAG del baúl.
 */

import { Router } from "express";
import multer from "multer";
import { unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { db, nuevoId, RUTA_UPLOADS } from "../db.js";
import { auditar } from "../auditoria.js";
import { exigirAccesoAPaciente, exigirConsentimiento, pacientesVisibles } from "../auth.js";
import { extraerDocumento, responderDesdeElBaul } from "../claude.js";
import { cifrar, descifrar, descifrarCampos, descifrarJson, detectarPII, escribirArchivoCifrado } from "../seguridad.js";
import { buscar, reindexarDocumento } from "../rag.js";
import { matriz, huecosDeLaMatriz, diaRelativo, hitosProximos } from "../motor.js";

export const rutasBaul = Router();

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 4 },
});

const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/gif", "image/webp"];

// --- El baúl compuesto ------------------------------------------------------

rutasBaul.get("/pacientes/:pacienteId/baul", exigirAccesoAPaciente, (req, res) => {
  const { pacienteId } = req.params;
   const paciente = descifrarCampos(db.prepare("SELECT * FROM pacientes WHERE id = ?").get(pacienteId), ["nombre_ficticio", "comuna_ficticia"]);
  if (!paciente) return res.status(404).json({ error: "Paciente no encontrado." });

  const evento = db
    .prepare(
      `SELECT e.*, est.nombre AS establecimiento_nombre
       FROM eventos_quirurgicos e
       LEFT JOIN establecimientos est ON est.id = e.establecimiento_id
       WHERE e.paciente_id = ? ORDER BY e.fecha_alta DESC LIMIT 1`,
    )
    .get(pacienteId);
   const indicaciones = evento
     ? db
        .prepare("SELECT * FROM indicaciones_alta WHERE evento_quirurgico_id = ?")
         .all(evento.id).map(descifrarIndicacion)
    : [];
  const conciliacion = db
    .prepare("SELECT * FROM conciliacion_farmacologica WHERE paciente_id = ?")
    .all(pacienteId);
  const documentos = db
    .prepare(
      "SELECT * FROM documentos_clinicos WHERE paciente_id = ? ORDER BY fecha_subida DESC",
    )
    .all(pacienteId);
   const campos = db
    .prepare(
      `SELECT t.* FROM trazabilidad_extraccion t
       JOIN documentos_clinicos d ON d.id = t.documento_id
       WHERE d.paciente_id = ? ORDER BY t.fecha_extraccion DESC`,
    )
     .all(pacienteId).map((c) => ({ ...c, valor_estructurado: descifrar(c.valor_estructurado), texto_original: descifrar(c.texto_original) }));
  const alertas = db
    .prepare(
      "SELECT * FROM alertas WHERE paciente_id = ? ORDER BY fecha_creacion DESC LIMIT 20",
    )
     .all(pacienteId).map(descifrarAlerta);
  const seguimientos = db
    .prepare(
      "SELECT * FROM seguimientos WHERE paciente_id = ? ORDER BY fecha_registro DESC LIMIT 30",
    )
       .all(pacienteId);

  const m = matriz();
  const dia = evento?.fecha_alta ? diaRelativo(evento.fecha_alta) : null;

  res.json({
    paciente,
    evento: evento ?? null,
    indicaciones,
    conciliacion,
    documentos,
    campos,
    alertas,
    seguimientos,
    diaPostoperatorio: dia,
    hitosProximos: dia !== null ? hitosProximos(m, dia) : [],
    matriz: { id: m.id, cirugia: m.cirugia, huecos: huecosDeLaMatriz(m) },
  });
});

// --- Subir y procesar un documento fotografiado -----------------------------

rutasBaul.post(
  "/pacientes/:pacienteId/documentos",
  exigirAccesoAPaciente,
  exigirConsentimiento("uso_ia"),
  subida.array("imagenes", 4),
  async (req, res, next) => {
    try {
      const { pacienteId } = req.params;
       const archivos = req.files ?? [];
       const textoDocumento = String(req.body?.texto ?? "").trim();
       if (archivos.length === 0 && !textoDocumento) {
         return res.status(400).json({ error: "Se requiere texto o al menos una imagen." });
      }
      for (const a of archivos) {
        if (!TIPOS_IMAGEN.includes(a.mimetype)) {
          return res
            .status(400)
            .json({ error: `Formato no aceptado: ${a.mimetype}` });
        }
      }

       if (detectarPII(textoDocumento).length > 0) {
         const err = new Error("El texto del documento contiene datos personales no permitidos.");
         err.status = 422;
         throw err;
       }
       const { borrador, uso } = await extraerDocumento(
         archivos.map((a) => ({
          mediaType: a.mimetype,
          base64: a.buffer.toString("base64"),
         })), textoDocumento,
       );
       if (detectarPII(JSON.stringify(borrador)).length > 0) {
         const err = new Error("El borrador contiene datos personales no permitidos.");
         err.status = 422;
         throw err;
       }

      const documentoId = nuevoId("DOC");
       const nombre = archivos.map((a) => a.originalname).join(", ") || "documento_texto.txt";
       const rutaLocal = archivos.length ? path.join(RUTA_UPLOADS, `${documentoId}-0${path.extname(archivos[0].originalname) || ".jpg"}`) : null;
       archivos.forEach((a, i) => {
         const temporal = path.join(RUTA_UPLOADS, `.tmp-${documentoId}-${i}`);
         writeFileSync(temporal, a.buffer);
         escribirArchivoCifrado(
           temporal,
           path.join(RUTA_UPLOADS, `${documentoId}-${i}${path.extname(a.originalname) || ".jpg"}`),
         );
         unlinkSync(temporal);
       });

      const TIPO_DOC = {
        informe_alta: "informe_de_alta",
        receta: "receta",
        protocolo_operatorio: "protocolo_operatorio",
        examen: "examen",
        indicaciones_curacion: "indicacion_medica",
        desconocido: "otro",
      };
      db.prepare(
        `INSERT INTO documentos_clinicos (id, paciente_id, nombre_original, tipo_documento, ruta_local, estado_proceso)
          VALUES (?, ?, ?, ?, ?, 'borrador')`,
      ).run(documentoId, pacienteId, nombre, TIPO_DOC[borrador.tipo_documento] ?? "otro", rutaLocal);

      // Cada campo extraído queda como BORRADOR con su cita literal.
      const insertarCampo = db.prepare(
        `INSERT INTO trazabilidad_extraccion
           (id, documento_id, campo, valor_estructurado, texto_original, confianza_texto, extraido_por, confirmado)
         VALUES (?, ?, ?, ?, ?, ?, 'claude_api', 0)`,
      );
      const campos = [];
      if (borrador.fecha_alta) campos.push(["fecha_alta", borrador.fecha_alta.valor, borrador.fecha_alta.texto_original, borrador.fecha_alta.confianza]);
      for (const m of borrador.medicamentos ?? []) {
        campos.push(["medicamento", JSON.stringify(m), m.texto_original, m.confianza]);
      }
      if (borrador.indicaciones_curacion) campos.push(["indicaciones_curacion", borrador.indicaciones_curacion.valor, borrador.indicaciones_curacion.texto_original, borrador.indicaciones_curacion.confianza]);
      if (borrador.proximo_control) campos.push(["proximo_control", borrador.proximo_control.valor, borrador.proximo_control.texto_original, borrador.proximo_control.confianza]);
      for (const a of borrador.alergias ?? []) {
        campos.push(["alergia", a.valor, a.texto_original, a.confianza]);
      }
       for (const [campo, valor, texto, confianza] of campos) {
         insertarCampo.run(nuevoId("TRZ"), documentoId, campo, valor === null || valor === undefined ? null : cifrar(valor), texto === null || texto === undefined ? null : cifrar(texto), confianza ?? null);
      }

      auditar({ usuario: req.usuario, accion: "escritura", recurso: `documentos/${documentoId}`, req });
      registrarOperacionIA(pacienteId, "recoleccion");

      res.status(201).json({ documentoId, borrador, uso });
    } catch (err) {
      next(err);
    }
  },
);

// --- Confirmar un documento contra el papel ---------------------------------

rutasBaul.post("/documentos/:documentoId/confirmar", (req, res) => {
  const documento = db
    .prepare("SELECT * FROM documentos_clinicos WHERE id = ?")
    .get(req.params.documentoId);
  if (!documento) return res.status(404).json({ error: "Documento no encontrado." });
  if (!pacientesVisibles(req.usuario).includes(documento.paciente_id)) {
    return res.status(403).json({ error: "No tienes autorización sobre este paciente." });
  }

   const campos = db
     .prepare("SELECT * FROM trazabilidad_extraccion WHERE documento_id = ?")
     .all(documento.id)
     .map((campo) => ({ ...campo, valor_estructurado: descifrar(campo.valor_estructurado), texto_original: descifrar(campo.texto_original) }));
  const marcar = db.prepare(
    `UPDATE trazabilidad_extraccion
     SET confirmado = 1, confirmado_por = ?,
         revisado_por_profesional = CASE WHEN ? = 'profesional' THEN 1 ELSE revisado_por_profesional END
     WHERE id = ?`,
  );
  for (const c of campos) {
    marcar.run(req.usuario.id, req.usuario.tipo, c.id);
    auditar({
      usuario: req.usuario,
      accion: "modificacion",
      recurso: `trazabilidad/${c.id}`,
      campo: "confirmado",
      valorAnterior: c.confirmado,
      valorNuevo: 1,
      req,
    });
  }

  // Recién ahora el contenido confirmado entra al índice RAG del baúl.
  const texto = campos
    .map((c) => `${c.campo}: ${c.texto_original ?? c.valor_estructurado ?? ""}`)
    .join("\n\n");
   reindexarDocumento(documento.id, {
    texto,
    tipo: "documento_paciente",
    fuente: `${documento.tipo_documento} (${documento.nombre_original})`,
     pacienteId: documento.paciente_id,
   });
   db.prepare("UPDATE documentos_clinicos SET estado_proceso = 'procesado' WHERE id = ?").run(documento.id);

  res.json({ ok: true, camposConfirmados: campos.length });
});

// --- Pregúntale al baúl (RAG) ----------------------------------------------

rutasBaul.post(
  "/pacientes/:pacienteId/preguntar",
  exigirAccesoAPaciente,
  exigirConsentimiento("uso_ia"),
  async (req, res, next) => {
    try {
      const { pacienteId } = req.params;
       const pregunta = String(req.body?.pregunta ?? "").trim();
      if (!pregunta) return res.status(400).json({ error: "Falta la pregunta." });
       if (pregunta.length > 500) {
        return res.status(400).json({ error: "La pregunta es demasiado larga." });
       }
       if (detectarPII(pregunta).length > 0) {
         return res.status(422).json({ error: "La pregunta contiene datos personales no permitidos." });
       }

      const { delPaciente, oficiales } = buscar(pregunta, pacienteId);
      const fragmentos = [...delPaciente, ...oficiales];

      const paciente = db
        .prepare("SELECT rango_edad, sexo FROM pacientes WHERE id = ?")
        .get(pacienteId);
      const evento = db
        .prepare(
          "SELECT fecha_alta FROM eventos_quirurgicos WHERE paciente_id = ? ORDER BY fecha_alta DESC LIMIT 1",
        )
        .get(pacienteId);
      const dia = evento?.fecha_alta ? diaRelativo(evento.fecha_alta) : null;
      const contexto = `persona de ${paciente?.rango_edad ?? "?"} años, operada de endoprótesis total de cadera, día postoperatorio ${dia ?? "desconocido"}.`;

      const resultado = await responderDesdeElBaul(pregunta, fragmentos, contexto);

      auditar({ usuario: req.usuario, accion: "lectura", recurso: `baul/${pacienteId}/preguntar`, req });
      registrarOperacionIA(pacienteId, "analisis_ia");

      res.json({
        ...resultado,
        fragmentos: fragmentos.map((f, i) => ({
          n: i + 1,
          tipo: f.tipo,
          fuente: f.fuente,
          seccion: f.seccion,
          url: f.url_fuente,
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// --- Matriz y sus huecos (panel del cuidador/profesional) -------------------

rutasBaul.get("/matriz", (_req, res) => {
  const m = matriz();
  res.json({ matriz: m, huecos: huecosDeLaMatriz(m) });
});

function registrarOperacionIA(pacienteId, operacion) {
  const tratamiento = db
    .prepare("SELECT id FROM inventario_tratamiento WHERE activo = 1 LIMIT 1")
    .get();
  if (!tratamiento) return;
  db.prepare(
    `INSERT INTO registro_operacion (id, tratamiento_id, operacion, paciente_id, sistema_actor, base_consentimiento)
     VALUES (?, ?, ?, ?, 'backend_api', 1)`,
  ).run(nuevoId("OPE"), tratamiento.id, operacion, pacienteId);
}

function descifrarIndicacion(indicacion) {
  return {
    ...indicacion,
    medicamentos: descifrarJson(indicacion.medicamentos, []),
    signos_alarma: descifrarJson(indicacion.signos_alarma, []),
    dosis_indicada: descifrar(indicacion.dosis_indicada),
    frecuencia_indicada: descifrar(indicacion.frecuencia_indicada),
    duracion_indicada: descifrar(indicacion.duracion_indicada),
    curacion_herida: descifrar(indicacion.curacion_herida),
    restricciones_fisicas: descifrar(indicacion.restricciones_fisicas),
    alimentacion: descifrar(indicacion.alimentacion),
  };
}

function descifrarAlerta(alerta) {
  return { ...alerta, descripcion: descifrar(alerta.descripcion), accion_tomada: descifrar(alerta.accion_tomada) };
}
