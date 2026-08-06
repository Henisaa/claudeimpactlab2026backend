/**
 * Seed: los 8 casos sintéticos de BACKEND_IDEALIZADO §13.2, usuarios demo,
 * consentimientos, documentos sintéticos confirmados y el corpus RAG oficial
 * (fuentes MINSAL/DEIS del vault + matriz clínica).
 *
 * Todo es ficticio: nombres, comunas, establecimientos, profesionales y
 * "recetas". Ningún dato corresponde a una persona real.
 *
 * Correr: npm run seed   (idempotente: borra y vuelve a sembrar)
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { db, nuevoId, RUTA_DATA } from "./db.js";
import { hashClave } from "./auth.js";
import { indexar } from "./rag.js";
import { matriz, persistirMatriz } from "./motor.js";
import { cifrar, cifrarJson } from "./seguridad.js";

const VAULT = process.env.VAULT_DIR ?? path.join(RUTA_DATA, "..", "..", "claudeimpactlab2026obsidian");

const hoy = new Date();
function diasAtras(n) {
  const d = new Date(hoy);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// --- Limpieza (orden inverso a las FK) --------------------------------------

db.exec("PRAGMA foreign_keys = OFF");
for (const tabla of [
  "rag_fts", "rag_chunks", "registro_operacion", "inventario_tratamiento",
  "notificaciones_outbox", "cpo24_intentos", "solicitudes_rectificacion", "oposiciones_tratamiento", "solicitudes_arco",
  "auditoria_acceso", "consentimientos", "trazabilidad_extraccion",
  "documentos_clinicos", "alertas", "hitos_seguimiento", "seguimientos",
  "conciliacion_farmacologica", "indicaciones_alta", "eventos_quirurgicos",
  "usuarios", "cuidadores", "profesionales", "pacientes",
  "preferencias_accesibilidad", "matriz_versiones", "matriz_clinica", "establecimientos",
]) {
  db.exec(`DELETE FROM ${tabla}`);
}
db.exec("PRAGMA foreign_keys = ON");

// --- Establecimientos y profesional (ficticios) -----------------------------

db.prepare(
  `INSERT INTO establecimientos (id, nombre, region, comuna, tipo, nivel_atencion, complejidad, fuente_deis)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run("EST-0001", "Hospital Ficticio del Valle", "Metropolitana", "Talagante", "hospital", "hospitalaria", "alta", "estructura DEIS 2026 (nombres ficticios)");
db.prepare(
  `INSERT INTO establecimientos (id, nombre, region, comuna, tipo, nivel_atencion, complejidad, fuente_deis)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run("EST-0002", "CESFAM Ficticio Los Aromos", "Metropolitana", "Talagante", "CESFAM", "primaria", "baja", "estructura DEIS 2026 (nombres ficticios)");

db.prepare(
  `INSERT INTO profesionales (id, nombre_profesional, registro_profesional, establecimiento_id, rol)
   VALUES (?, ?, ?, ?, ?)`,
).run("PRO-0001", "E. Rojas (ficticio)", "SINT-12345", "EST-0001", "enfermera");

// --- Los 8 casos sintéticos (§13.2) -----------------------------------------

const CASOS = [
  { id: "SYN-ETC-0001", nombre: "María G.", edad: "65-74", sexo: "F", apoyo: "familiar", altaHace: 6, desc: "Recuperación sin complicaciones" },
  { id: "SYN-ETC-0002", nombre: "Carlos P.", edad: "65-74", sexo: "M", apoyo: "autonomo", altaHace: 3, desc: "Dolor que mejora progresivamente" },
  { id: "SYN-ETC-0003", nombre: "Rosa M.", edad: "75-84", sexo: "F", apoyo: "familiar", altaHace: 10, desc: "Confusión con medicamentos" },
  { id: "SYN-ETC-0004", nombre: "Luis H.", edad: "65-74", sexo: "M", apoyo: "cuidador", altaHace: 8, desc: "Alteración de la herida" },
  { id: "SYN-ETC-0005", nombre: "Ana V.", edad: "75-84", sexo: "F", apoyo: "familiar", altaHace: 2, desc: "Sangrado" },
  { id: "SYN-ETC-0006", nombre: "Pedro S.", edad: "85+", sexo: "M", apoyo: "autonomo", altaHace: 1, desc: "Paciente que no responde" },
  { id: "SYN-ETC-0007", nombre: "Elena T.", edad: "85+", sexo: "F", apoyo: "cuidador", altaHace: 15, desc: "Persona mayor con cuidador" },
  { id: "SYN-ETC-0008", nombre: "Jorge D.", edad: "75-84", sexo: "M", apoyo: "familiar", altaHace: 4, desc: "Derivación urgente" },
];

const insPaciente = db.prepare(
  `INSERT INTO pacientes (id, nombre_ficticio, rango_edad, sexo, comuna_ficticia, region, tipo_apoyo, consentimiento_activo)
  VALUES (?, ?, ?, ?, ?, 'Metropolitana', ?, 1)`,
);
const insEvento = db.prepare(
  `INSERT INTO eventos_quirurgicos
     (id, paciente_id, modalidad, establecimiento_id, servicio_clinico, anestesia,
      fecha_cirugia, fecha_ingreso, fecha_alta, dias_estadia, condicion_egreso, profesional_cirujano_id)
   VALUES (?, ?, 'hospitalaria', 'EST-0001', 'Traumatología', 'Raquídea (sintética)', ?, ?, ?, ?, 'Vivo, en buenas condiciones', 'PRO-0001')`,
);
const insIndicacion = db.prepare(
  `INSERT INTO indicaciones_alta
     (id, evento_quirurgico_id, medicamentos, curacion_herida, restricciones_fisicas,
      alimentacion, signos_alarma, canal_contacto, fecha_proximo_control, fuente, profesional_indica_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'informe de alta sintético', 'PRO-0001')`,
);

// Receta sintética estándar del caso índice (el ejemplo de rivaroxabán viene
// de la sección 7.3 de BACKEND_IDEALIZADO; dosis escritas por el "profesional
// ficticio" del caso, nunca calculadas por el sistema).
const MEDICAMENTOS = JSON.stringify([
  { nombre: "Paracetamol", dosis: "1 g", frecuencia: "cada 8 horas", duracion: "7 días", motivo: "Manejo del dolor postoperatorio" },
  { nombre: "Rivaroxabán", dosis: "10 mg", frecuencia: "cada 24 horas", duracion: "35 días", motivo: "Tromboprofilaxis" },
]);
const SIGNOS_ALARMA = JSON.stringify([
  "Dolor súbito intenso en la cadera operada o incapacidad de apoyar la pierna",
  "Enrojecimiento creciente, secreción o fiebre",
  "Sangrado inusual (encías, orina, deposiciones negras)",
  "Dificultad para respirar o dolor en el pecho",
]);

const eventos = {};
for (const c of CASOS) {
  insPaciente.run(c.id, cifrar(c.nombre), c.edad, c.sexo, cifrar("Talagante"), c.apoyo);
  const eventoId = nuevoId("EVT");
  eventos[c.id] = eventoId;
  insEvento.run(
    eventoId, c.id,
    diasAtras(c.altaHace + 3), diasAtras(c.altaHace + 4), diasAtras(c.altaHace), 3,
  );
  insIndicacion.run(
    nuevoId("IND"), eventoId, cifrarJson(JSON.parse(MEDICAMENTOS)),
    cifrar("Mantener la herida limpia y seca. Curación en CESFAM cada 3 días. No mojar hasta el retiro de puntos."),
    cifrar("No cruzar las piernas. No girar la pierna operada hacia adentro. No flexionar la cadera más de 90 grados. Usar silla alta y alzador de baño."),
    cifrar("Alimentación habitual, abundante agua."),
    cifrarJson(JSON.parse(SIGNOS_ALARMA)), "Salud Responde 600 360 7777",
    diasAtras(c.altaHace - 12), // control ~D+12
  );
  db.prepare(
    `INSERT INTO preferencias_accesibilidad (id, paciente_id) VALUES (?, ?)`,
  ).run(nuevoId("PRF"), c.id);
}

// Conciliación farmacológica del caso 0003 (confusión con medicamentos).
const insConc = db.prepare(
  `INSERT INTO conciliacion_farmacologica
     (id, paciente_id, evento_quirurgico_id, medicamento, estado, dosis_profesional,
      frecuencia_profesional, duracion_profesional, motivo_cambio, fuente)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'informe de alta sintético')`,
);
insConc.run(nuevoId("CFA"), "SYN-ETC-0003", eventos["SYN-ETC-0003"], "Losartán", "previo", "50 mg", "cada 24 horas", "crónico", null);
insConc.run(nuevoId("CFA"), "SYN-ETC-0003", eventos["SYN-ETC-0003"], "Rivaroxabán", "nuevo", "10 mg", "cada 24 horas", "35 días", "Tromboprofilaxis postoperatoria");
insConc.run(nuevoId("CFA"), "SYN-ETC-0003", eventos["SYN-ETC-0003"], "Aspirina", "suspendido", null, null, null, "Suspendida por el profesional durante la tromboprofilaxis");

// --- Cuidadores y usuarios demo ---------------------------------------------

const insCuidador = db.prepare(
  `INSERT INTO cuidadores (id, paciente_id, nombre_ficticio, relacion, permisos, consentimiento_paciente, fecha_autorizacion)
   VALUES (?, ?, ?, ?, '{"ver_expediente":true,"registrar_sintomas":true}', 1, datetime('now'))`,
);
insCuidador.run("CUI-0001", "SYN-ETC-0007", "Carmen T. (ficticio)", "hija");
insCuidador.run("CUI-0002", "SYN-ETC-0001", "Pablo G. (ficticio)", "hijo");

const insUsuario = db.prepare(
  `INSERT INTO usuarios (id, username, password_hash, tipo_usuario, paciente_id, cuidador_id, profesional_id)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const clave = hashClave("demo1234");
insUsuario.run("USR-0001", "paciente@demo", clave, "paciente", "SYN-ETC-0001", null, null);
insUsuario.run("USR-0002", "cuidador@demo", clave, "cuidador", null, "CUI-0001", null);
insUsuario.run("USR-0003", "profesional@demo", clave, "profesional", null, null, "PRO-0001");
insUsuario.run("USR-0004", "admin@demo", clave, "admin", null, null, null);

// --- Consentimientos (Decreto 31: evidencia verificable, no checkbox) -------

const insCons = db.prepare(
  `INSERT INTO consentimientos (id, paciente_id, tipo, otorgado, medio, version_formulario, formulario_hash)
   VALUES (?, ?, ?, 1, 'app', 'demo-v1', 'seed')`,
);
for (const c of CASOS) {
  for (const tipo of ["tratamiento_datos", "uso_ia", "contacto_telefonico"]) {
    insCons.run(nuevoId("CON"), c.id, tipo);
  }
}
insCons.run(nuevoId("CON"), "SYN-ETC-0001", "compartir_cuidador");
insCons.run(nuevoId("CON"), "SYN-ETC-0007", "compartir_cuidador");

db.prepare(
  `INSERT INTO inventario_tratamiento (id, finalidad, base_legal, categorias_datos, destinatarios, plazo_conservacion)
   VALUES (?, 'Seguimiento postoperatorio de continuidad de cuidados (prototipo con casos sintéticos)',
           'Consentimiento explícito del titular (Ley 21.719)',
           '["datos de salud sintéticos","documentos clínicos sintéticos"]',
           '["paciente","cuidador autorizado","profesional tratante"]', '5 años')`,
).run(nuevoId("TRA"));

persistirMatriz(matriz());

// --- Historias de seguimiento por caso --------------------------------------
// Solo se persisten alertas que el motor dispararía de verdad hoy: la única
// regla vigente con fuente es la de emergencia general (urgencias MINSAL).
// Los desenlaces esperados de los 8 casos quedan en data/casos-esperados.json
// para medir falsas alarmas cuando la matriz esté validada.

const insSeg = db.prepare(
  `INSERT INTO seguimientos
     (id, paciente_id, evento_quirurgico_id, dia_postoperatorio, fecha_registro,
      contacto_24h_realizado, dolor_reportado, sangrado, estado_herida, movilidad,
      adherencia_medicamentos, apoyo_cuidador, necesidad_derivacion, registrado_por, fuente_dato)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed caso sintético')`,
);
const seg = (pid, dia, extra = {}) => {
  const id = nuevoId("SEG");
  insSeg.run(
    id, pid, eventos[pid], dia,
    `${diasAtras(CASOS.find((c) => c.id === pid).altaHace - dia)} 10:00:00`,
    extra.contacto24 ?? 1, extra.dolor ?? 3, extra.sangrado ?? 0,
    extra.herida ?? "normal", extra.movilidad ?? "mejorando",
    extra.adherencia ?? "completa", extra.apoyo ?? 1, extra.derivacion ?? 0,
    extra.por ?? "paciente",
  );
  return id;
};

// 0001 recuperación esperada — verde todos los días
for (const d of [1, 2, 3, 4, 5, 6]) seg("SYN-ETC-0001", d, { dolor: 4 - Math.min(d, 3) });
// 0002 dolor que mejora
seg("SYN-ETC-0002", 1, { dolor: 6 }); seg("SYN-ETC-0002", 2, { dolor: 5 }); seg("SYN-ETC-0002", 3, { dolor: 4 });
// 0003 confusión con medicamentos (adherencia parcial; alerta amarilla PENDIENTE de matriz validada)
seg("SYN-ETC-0003", 8, { adherencia: "parcial", dolor: 4 });
seg("SYN-ETC-0003", 9, { adherencia: "parcial", dolor: 4 });
// 0004 alteración de la herida (amarilla pendiente de matriz validada)
seg("SYN-ETC-0004", 7, { herida: "inflamada", dolor: 5, por: "cuidador" });
// 0005 sangrado → emergencia general: única regla vigente, alerta ROJA real
const seg0005 = seg("SYN-ETC-0005", 2, { sangrado: 1, dolor: 6, derivacion: 1 });
db.prepare(
  `INSERT INTO alertas (id, seguimiento_id, paciente_id, nivel, descripcion)
   VALUES (?, ?, 'SYN-ETC-0005', 'roja', ?)`,
 ).run(nuevoId("ALR"), seg0005, cifrar("Situación de gravedad general: sangrado abundante reportado en check-in. — Regla r_emergencia (fuente: MINSAL, servicios de urgencia)."));
// 0006 paciente que no responde: hito contacto_24h pendiente, sin check-ins
db.prepare(
  `INSERT INTO hitos_seguimiento (id, paciente_id, evento_quirurgico_id, tipo_hito, dia_objetivo, estado)
   VALUES (?, 'SYN-ETC-0006', ?, 'contacto_24h', 1, 'pendiente')`,
).run(nuevoId("HIT"), eventos["SYN-ETC-0006"]);
// 0007 persona mayor con cuidador: registra el cuidador
for (const d of [13, 14, 15]) seg("SYN-ETC-0007", d, { por: "cuidador", dolor: 2 });
// 0008 derivación urgente, atendida y documentada por el profesional
const seg0008 = seg("SYN-ETC-0008", 3, { dolor: 8, derivacion: 1 });
db.prepare(
  `INSERT INTO alertas (id, seguimiento_id, paciente_id, nivel, descripcion, estado, atendida_por, fecha_atencion, accion_tomada)
   VALUES (?, ?, 'SYN-ETC-0008', 'roja', ?,
           'resuelta', 'PRO-0001', datetime('now'), ?)`,
 ).run(nuevoId("ALR"), seg0008,
   cifrar("Situación de gravedad general reportada en check-in. — Regla r_emergencia (fuente: MINSAL, servicios de urgencia)."),
   cifrar("Derivación a servicio de urgencia coordinada con la familia (caso sintético)."));

// hito contacto_24h cumplido para el resto
for (const c of CASOS.filter((c) => c.id !== "SYN-ETC-0006")) {
  db.prepare(
    `INSERT INTO hitos_seguimiento (id, paciente_id, evento_quirurgico_id, tipo_hito, dia_objetivo, estado, fecha_cumplimiento)
     VALUES (?, ?, ?, 'contacto_24h', 1, 'cumplida', ?)`,
  ).run(nuevoId("HIT"), c.id, eventos[c.id], diasAtras(c.altaHace - 1));
}

// --- Documento sintético confirmado por paciente (alimenta el RAG) ----------

const insDoc = db.prepare(
  `INSERT INTO documentos_clinicos (id, paciente_id, nombre_original, tipo_documento, estado_proceso)
   VALUES (?, ?, ?, 'informe_de_alta', 'procesado')`,
);
const insTrz = db.prepare(
  `INSERT INTO trazabilidad_extraccion
     (id, documento_id, campo, valor_estructurado, texto_original, confianza_texto, extraido_por, confirmado, confirmado_por, revisado_por_profesional)
   VALUES (?, ?, ?, ?, ?, 'alta', 'seed', 1, 'seed', 1)`,
);
for (const c of CASOS) {
  const docId = nuevoId("DOC");
  insDoc.run(docId, c.id, "informe_alta_sintetico.pdf");
  const filas = [
    ["fecha_alta", diasAtras(c.altaHace), `Fecha de alta: ${diasAtras(c.altaHace)}`],
    ["medicamento", '{"nombre":"Paracetamol"}', "Paracetamol 1 g cada 8 horas por 7 días, para el dolor"],
    ["medicamento", '{"nombre":"Rivaroxabán"}', "Rivaroxabán 10 mg cada 24 horas por 35 días (tromboprofilaxis). Suspender aspirina durante este período."],
    ["indicaciones_curacion", null, "Mantener la herida limpia y seca. Curación en CESFAM cada 3 días. No mojar la herida hasta el retiro de puntos."],
    ["restricciones", null, "No cruzar las piernas. No girar la pierna operada hacia adentro. No flexionar la cadera más de 90 grados. Usar silla alta y alzador de baño."],
    ["proximo_control", diasAtras(c.altaHace - 12), `Control traumatológico: ${diasAtras(c.altaHace - 12)} en Hospital Ficticio del Valle. Ante señales de alarma llamar a Salud Responde 600 360 7777.`],
  ];
  let texto = "";
  for (const [campo, valor, cita] of filas) {
    insTrz.run(nuevoId("TRZ"), docId, campo, valor === null ? null : (campo === "medicamento" ? cifrar(valor) : cifrar(valor)), cifrar(cita));
    texto += `${campo}: ${cita}\n\n`;
  }
  indexar({
    texto,
    tipo: "documento_paciente",
    fuente: "informe de alta (informe_alta_sintetico.pdf)",
    pacienteId: c.id,
    documentoId: docId,
  });
}

// --- Corpus RAG oficial ------------------------------------------------------

const FUENTES_VAULT = [
  ["Data_Real_Salud_Linea_03.txt", "Paquete de fuentes oficiales MINSAL/DEIS — Línea 03"],
  ["Datos_Linea_03_MINSAL_DEIS.txt", "Datos MINSAL/DEIS — Línea 03"],
  ["Linea_03_Continuidad_Medicina_de_Precision.md", "Línea 03 — Continuidad y Medicina de Precisión (documento del proyecto)"],
];
let chunksOficiales = 0;
for (const [archivo, nombre] of FUENTES_VAULT) {
  const ruta = path.join(VAULT, archivo);
  if (!existsSync(ruta)) {
    console.warn(`(aviso) No se encontró ${ruta}; ese corpus no se indexa.`);
    continue;
  }
  chunksOficiales += indexar({
    texto: readFileSync(ruta, "utf8"),
    tipo: "guia_oficial",
    fuente: nombre,
  }).length;
}

// La matriz clínica también responde preguntas: solo sus filas con fuente.
const m = matriz();
for (const s of m.sintomasEsperados.filter((x) => x.estado === "vigente" && x.fuente)) {
  chunksOficiales += indexar({
    texto: `${s.descripcion}\n${s.mensajeNormalizador}`,
    tipo: "matriz_clinica",
    fuente: `Matriz clínica ${m.id} — síntoma esperado (${s.fuente.institucion})`,
    urlFuente: s.fuente.url,
    seccion: s.id,
  }).length;
}
for (const s of m.senalesAlarma.filter((x) => x.estado === "vigente" && x.fuente)) {
  chunksOficiales += indexar({
    texto: `Señal de alarma (${s.color}): ${s.descripcion} Qué hacer: ${s.accion}`,
    tipo: "matriz_clinica",
    fuente: `Matriz clínica ${m.id} — señal de alarma (${s.fuente.institucion})`,
    urlFuente: s.fuente.url,
    seccion: s.id,
  }).length;
}

// --- Desenlaces esperados para la evaluación --------------------------------

import { writeFileSync } from "node:fs";
writeFileSync(
  path.join(RUTA_DATA, "casos-esperados.json"),
  JSON.stringify(
    CASOS.map((c) => ({
      caso: c.id,
      descripcion: c.desc,
      resultadoEsperado: {
        "SYN-ETC-0001": "Seguimiento completo, sin alertas rojas",
        "SYN-ETC-0002": "Alertas verdes, control normal",
        "SYN-ETC-0003": "Alerta amarilla, revisión profesional (bloqueada hasta validar matriz)",
        "SYN-ETC-0004": "Alerta amarilla, posible escalamiento (bloqueada hasta validar matriz)",
        "SYN-ETC-0005": "Alerta roja, derivación urgente",
        "SYN-ETC-0006": "Escalamiento a cuidador y establecimiento",
        "SYN-ETC-0007": "Acceso compartido, confirmación de comprensión",
        "SYN-ETC-0008": "Alerta roja, intervención profesional",
      }[c.id],
    })),
    null,
    2,
  ),
  "utf8",
);

const n = (t) => db.prepare(`SELECT count(*) c FROM ${t}`).get().c;
console.log(`Seed listo:
  pacientes:            ${n("pacientes")}
  eventos quirúrgicos:  ${n("eventos_quirurgicos")}
  seguimientos:         ${n("seguimientos")}
  alertas:              ${n("alertas")}
  consentimientos:      ${n("consentimientos")}
  documentos:           ${n("documentos_clinicos")}
  campos trazables:     ${n("trazabilidad_extraccion")}
  chunks RAG:           ${n("rag_chunks")} (${chunksOficiales} oficiales)
Usuarios demo (clave demo1234): paciente@demo, cuidador@demo, profesional@demo, admin@demo`);
