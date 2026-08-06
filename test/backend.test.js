import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const carpeta = mkdtempSync(path.join(tmpdir(), "etc-backend-"));
process.env.DB_PATH = path.join(carpeta, "test.db");
process.env.DEMO_MODE = "true";
process.env.CLAUDE_MOCK = "true";
process.env.JWT_SECRET = "test-secret";
process.env.ENCRYPTION_KEY = "test-encryption-key";

const { app } = await import("../src/server.js");
await import(`../src/seed.js?test=${Date.now()}`);
const { db } = await import("../src/db.js");
const { escribirArchivoCifrado, leerArchivoCifrado } = await import("../src/seguridad.js");

let servidor;
let base;
const tokens = {};

async function request(ruta, opciones = {}, token = null) {
  const headers = { ...(opciones.body === undefined ? {} : { "content-type": "application/json" }), ...(opciones.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${ruta}`, { ...opciones, headers, body: opciones.body === undefined ? undefined : JSON.stringify(opciones.body) });
}

async function login(nombre) {
  const respuesta = await request("/api/v1/auth/login", { method: "POST", body: { username: nombre, password: "demo1234" } });
  assert.equal(respuesta.status, 200);
  return (await respuesta.json()).token;
}

const checkin = (cambios = {}) => ({ respuestas: { emergencia: "no", dolor: "mejor", herida: "igual", movilidad: "si_solo", medicamentos: "si", ...cambios } });

before(async () => {
  servidor = app.listen(0);
  await new Promise((resolve) => servidor.once("listening", resolve));
  base = `http://127.0.0.1:${servidor.address().port}`;
  tokens.paciente = await login("paciente@demo");
  tokens.cuidador = await login("cuidador@demo");
  tokens.profesional = await login("profesional@demo");
  tokens.admin = await login("admin@demo");
});

after(() => {
  servidor?.close();
  db.close();
  rmSync(carpeta, { recursive: true, force: true });
});

test("login correcto y fallido quedan auditados", async () => {
  const fallido = await request("/api/v1/auth/login", { method: "POST", body: { username: "paciente@demo", password: "incorrecta" } });
  assert.equal(fallido.status, 401);
  assert.ok(db.prepare("SELECT 1 FROM auditoria_acceso WHERE accion = 'login_fallido'").get());
});

test("separación de roles y acceso cruzado", async () => {
  const otro = await request("/api/v1/pacientes/SYN-ETC-0002/baul", {}, tokens.paciente);
  assert.equal(otro.status, 403);
  const adminClinico = await request("/api/v1/pacientes/SYN-ETC-0001/baul", {}, tokens.admin);
  assert.equal(adminClinico.status, 403);
  const alertasPaciente = await request("/api/v1/alertas", {}, tokens.paciente);
  assert.equal(alertasPaciente.status, 200);
});

test("consentimiento de IA bloquea y luego permite extracción MOCK", async () => {
  const revocar = await request("/api/v1/pacientes/SYN-ETC-0001/consentimientos", { method: "POST", body: { tipo: "uso_ia", otorgado: false } }, tokens.paciente);
  assert.equal(revocar.status, 201);
  const bloqueado = await request("/api/v1/pacientes/SYN-ETC-0001/documentos", { method: "POST", body: { texto: "Alta 2026-08-01. Paracetamol 1 g cada 8 horas por 7 días." } }, tokens.paciente);
  assert.equal(bloqueado.status, 403);
  await request("/api/v1/pacientes/SYN-ETC-0001/consentimientos", { method: "POST", body: { tipo: "uso_ia", otorgado: true } }, tokens.paciente);
  const extraido = await request("/api/v1/pacientes/SYN-ETC-0001/documentos", { method: "POST", body: { texto: "Alta 2026-08-01. Paracetamol 1 g cada 8 horas por 7 días." } }, tokens.paciente);
  assert.equal(extraido.status, 201);
  const cuerpo = await extraido.json();
  assert.equal(cuerpo.borrador.medicamentos[0].nombre, "Paracetamol");
  assert.equal(db.prepare("SELECT estado_proceso FROM documentos_clinicos WHERE id = ?").get(cuerpo.documentoId).estado_proceso, "borrador");
  const confirmar = await request(`/api/v1/documentos/${cuerpo.documentoId}/confirmar`, { method: "POST", body: {} }, tokens.paciente);
  assert.equal(confirmar.status, 200);
  assert.ok(db.prepare("SELECT 1 FROM rag_chunks WHERE documento_id = ?").get(cuerpo.documentoId));
});

test("revocar compartir_cuidador corta el acceso inmediatamente", async () => {
  const alta = await request("/api/v1/admin/usuarios", { method: "POST", body: { username: "paciente7@demo", password: "demo1234", tipo: "paciente", pacienteId: "SYN-ETC-0007" } }, tokens.admin);
  assert.equal(alta.status, 201);
  const paciente7 = await login("paciente7@demo");
  const revocar = await request("/api/v1/pacientes/SYN-ETC-0007/consentimientos", { method: "POST", body: { tipo: "compartir_cuidador", otorgado: false } }, paciente7);
  assert.equal(revocar.status, 201);
  const acceso = await request("/api/v1/pacientes/SYN-ETC-0007/baul", {}, tokens.cuidador);
  assert.equal(acceso.status, 403);
});

test("PII se rechaza antes de persistir y la pregunta PII devuelve 422", async () => {
  const antes = db.prepare("SELECT count(*) AS n FROM documentos_clinicos").get().n;
  const documento = await request("/api/v1/pacientes/SYN-ETC-0001/documentos", { method: "POST", body: { texto: "Juan Perez RUN 12345678-5: Paracetamol 1 g." } }, tokens.paciente);
  assert.equal(documento.status, 422);
  assert.equal(db.prepare("SELECT count(*) AS n FROM documentos_clinicos").get().n, antes);
  const pregunta = await request("/api/v1/pacientes/SYN-ETC-0001/preguntar", { method: "POST", body: { pregunta: "¿Qué dice Juan Perez?" } }, tokens.paciente);
  assert.equal(pregunta.status, 422);
});

test("check-in completo valida y conserva campos, con revisión profesional", async () => {
  const respuesta = await request("/api/v1/pacientes/SYN-ETC-0001/checkins", { method: "POST", body: checkin({ dolor: 4, nauseas: true, vomitos: false, fiebre: false, confusion: false, sangrado: false, alimentacion: "adecuada", apoyoCuidador: true, controlAgendado: true }) }, tokens.paciente);
  assert.equal(respuesta.status, 201);
  const cuerpo = await respuesta.json();
  assert.equal(cuerpo.requiere_revision_profesional, true);
  const fila = db.prepare("SELECT * FROM seguimientos WHERE id = ?").get(cuerpo.seguimientoId);
  assert.equal(fila.dolor_reportado, 4);
  assert.equal(fila.nauseas, 1);
  assert.equal(fila.alimentacion_hidratacion, "adecuada");
});

test("check-in rechaza claves desconocidas y opciones inválidas", async () => {
  const desconocida = await request("/api/v1/pacientes/SYN-ETC-0001/checkins", { method: "POST", body: checkin({ inventada: true }) }, tokens.paciente);
  assert.equal(desconocida.status, 400);
  const opcion = await request("/api/v1/pacientes/SYN-ETC-0001/checkins", { method: "POST", body: checkin({ herida: "otra" }) }, tokens.paciente);
  assert.equal(opcion.status, 400);
});

test("alerta roja determinística, visibilidad y atención profesional documentada", async () => {
  const checkinUrgente = await request("/api/v1/pacientes/SYN-ETC-0001/checkins", { method: "POST", body: checkin({ emergencia: "si" }) }, tokens.paciente);
  assert.equal(checkinUrgente.status, 201);
  const paciente = await request("/api/v1/alertas", {}, tokens.paciente);
  assert.equal(paciente.status, 200);
  const roja = (await paciente.json()).alertas.find((alerta) => alerta.paciente_id === "SYN-ETC-0001" && alerta.nivel === "roja");
  const noPuede = await request(`/api/v1/alertas/${roja.id}/atender`, { method: "POST", body: { accionTomada: "no" } }, tokens.paciente);
  assert.equal(noPuede.status, 403);
  const profesional = await request(`/api/v1/alertas/${roja.id}/atender`, { method: "POST", body: { accionTomada: "Derivación documentada a urgencia." } }, tokens.profesional);
  assert.equal(profesional.status, 200);
  assert.equal(db.prepare("SELECT estado FROM alertas WHERE id = ?").get(roja.id).estado, "resuelta");
});

test("CPO-24 genera outbox en los umbrales 3 y 5", async () => {
  for (let i = 0; i < 5; i++) {
    const respuesta = await request("/api/v1/pacientes/SYN-ETC-0001/cpo24/intentos", { method: "POST", body: { respondio: false } }, tokens.profesional);
    assert.equal(respuesta.status, 201);
  }
  const destinos = db.prepare("SELECT destinatario_tipo FROM notificaciones_outbox WHERE paciente_id = 'SYN-ETC-0001'").all().map((fila) => fila.destinatario_tipo);
  assert.ok(destinos.includes("cuidador"));
  assert.ok(destinos.includes("establecimiento"));
});

test("admin gestiona usuarios sin exponer hash y exporta auditoría", async () => {
  const usuarios = await request("/api/v1/admin/usuarios", {}, tokens.admin);
  assert.equal(usuarios.status, 200);
  assert.equal("password_hash" in (await usuarios.json()).usuarios[0], false);
  const exportacion = await request("/api/v1/admin/auditoria/export", {}, tokens.admin);
  assert.equal(exportacion.status, 200);
  assert.match(await exportacion.text(), /usuario_id/);
});

test("campos sensibles están cifrados en SQLite y descifrados en API", async () => {
  const bruto = db.prepare("SELECT nombre_ficticio FROM pacientes WHERE id = 'SYN-ETC-0001'").get().nombre_ficticio;
  assert.notEqual(bruto, "María G.");
  const baul = await request("/api/v1/pacientes/SYN-ETC-0001/baul", {}, tokens.paciente);
  assert.equal((await baul.json()).paciente.nombre_ficticio, "María G.");
});

test("los archivos subidos se pueden cifrar y leer sin exponer el contenido", () => {
  const origen = path.join(carpeta, "origen.txt");
  const destino = path.join(carpeta, "cifrado.bin");
  writeFileSync(origen, "documento sintético");
  escribirArchivoCifrado(origen, destino);
  assert.notEqual(readFileSync(destino, "utf8"), "documento sintético");
  assert.equal(leerArchivoCifrado(destino).toString(), "documento sintético");
});

test("rectificación queda pendiente y requiere revisión profesional", async () => {
  const solicitud = await request("/api/v1/pacientes/SYN-ETC-0001/mis-datos/nombre_ficticio", { method: "PATCH", body: { valorSolicitado: "María Rectificada", motivo: "Corrección sintética" } }, tokens.paciente);
  assert.equal(solicitud.status, 202);
  const pendientes = await request("/api/v1/rectificaciones/pendientes", {}, tokens.profesional);
  assert.equal(pendientes.status, 200);
  const id = (await pendientes.json()).rectificaciones.find((fila) => fila.paciente_id === "SYN-ETC-0001").id;
  const revisar = await request(`/api/v1/rectificaciones/${id}/revisar`, { method: "POST", body: { decision: "aplicar" } }, tokens.profesional);
  assert.equal(revisar.status, 200);
});

test("un control sin medicamentos confirmados avisa a la persona de apoyo, sin datos clínicos", async () => {
  const respuesta = await request("/api/v1/pacientes/SYN-ETC-0001/checkins", { method: "POST", body: checkin({ medicamentos: "no" }) }, tokens.paciente);
  assert.equal(respuesta.status, 201);
  assert.ok((await respuesta.json()).notificaciones.length >= 1);

  const procesar = await request("/api/v1/pacientes/SYN-ETC-0001/notificaciones/procesar", { method: "POST", body: {} }, tokens.paciente);
  assert.ok((await procesar.json()).enviadas >= 1);

  const bandeja = await request("/api/v1/pacientes/SYN-ETC-0001/notificaciones", {}, tokens.paciente);
  const aviso = (await bandeja.json()).notificaciones.find((n) => n.evento === "MEDICACION_SIN_CONFIRMAR");
  assert.equal(aviso.canal, "whatsapp");
  assert.equal(aviso.estado, "enviada");
  // El canal es de terceros: el mensaje no nombra a la persona ni el síntoma.
  for (const filtrado of ["María", "SYN-ETC-0001", "dolor", "herida", "Rivaroxab"]) {
    assert.ok(!aviso.mensaje.includes(filtrado), `el mensaje no debe contener "${filtrado}"`);
  }
});

test("sin consentimiento de contacto el aviso se cancela, no se envía", async () => {
  const revocar = await request("/api/v1/pacientes/SYN-ETC-0001/consentimientos/contacto_telefonico", { method: "DELETE" }, tokens.paciente);
  assert.equal(revocar.status, 200);

  await request("/api/v1/pacientes/SYN-ETC-0001/checkins", { method: "POST", body: checkin({ medicamentos: "no" }) }, tokens.paciente);
  const procesar = await request("/api/v1/pacientes/SYN-ETC-0001/notificaciones/procesar", { method: "POST", body: {} }, tokens.paciente);
  const resultado = await procesar.json();
  assert.equal(resultado.enviadas, 0);
  assert.ok(resultado.canceladas >= 1);

  const bandeja = await request("/api/v1/pacientes/SYN-ETC-0001/notificaciones", {}, tokens.paciente);
  const cancelado = (await bandeja.json()).notificaciones.find((n) => n.estado === "cancelada");
  assert.ok(cancelado, "debe quedar registrado el aviso cancelado");
  assert.match(cancelado.ultimo_error, /consentimiento/i);
});

test("medicación: la foto que coincide verifica la toma y avisa a la persona de apoyo", async () => {
  const hoy = await request("/api/v1/pacientes/SYN-ETC-0001/medicacion/hoy", {}, tokens.paciente);
  assert.equal(hoy.status, 200);
  const cuerpo = await hoy.json();
  assert.ok(cuerpo.planes.length >= 1, "el seed deja un plan activo");
  assert.ok(cuerpo.tomas.length >= 1, "el seed materializa la toma de hoy");

  const toma = cuerpo.tomas[0];
  const formulario = new FormData();
  formulario.append("imagen", new Blob(["foto-demo"], { type: "image/jpeg" }), "foto.jpg");
  formulario.append("demoResultado", "coincide");
  const foto = await fetch(`${base}/api/v1/medicacion/tomas/${toma.id}/foto`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.paciente}` },
    body: formulario,
  });
  assert.equal(foto.status, 201);
  const resultado = await foto.json();
  assert.equal(resultado.verificacion.resultado_comparacion, "coincide");
  assert.equal(resultado.verificacion.requiere_revision_profesional, 1);
  assert.equal(db.prepare("SELECT estado FROM tomas_programadas WHERE id = ?").get(toma.id).estado, "coincide");
  assert.ok(
    db
      .prepare("SELECT 1 FROM notificaciones_outbox WHERE paciente_id = 'SYN-ETC-0001' AND evento = 'MEDICACION_VERIFICADA'")
      .get(),
    "la verificación encola el aviso de WhatsApp",
  );
  assert.ok(db.prepare("SELECT 1 FROM evidencias_medicacion WHERE toma_programada_id = ?").get(toma.id), "la foto queda como evidencia cifrada");

  const confirmar = await request(`/api/v1/medicacion/tomas/${toma.id}/confirmar`, { method: "POST", body: { declaracion: "tomada" } }, tokens.paciente);
  assert.equal(confirmar.status, 200);
  assert.equal(db.prepare("SELECT declaracion FROM tomas_programadas WHERE id = ?").get(toma.id).declaracion, "tomada");
});

test("medicación: un medicamento distinto queda no_coincide y requiere revisión profesional", async () => {
  const crear = await request("/api/v1/pacientes/SYN-ETC-0001/medicacion/demo/toma-hoy", { method: "POST", body: {} }, tokens.paciente);
  assert.equal(crear.status, 201);
  const toma = (await crear.json()).toma;

  const formulario = new FormData();
  formulario.append("imagen", new Blob(["foto-demo"], { type: "image/jpeg" }), "foto.jpg");
  formulario.append("demoResultado", "no_coincide");
  const foto = await fetch(`${base}/api/v1/medicacion/tomas/${toma.id}/foto`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.paciente}` },
    body: formulario,
  });
  assert.equal(foto.status, 201);
  const resultado = await foto.json();
  assert.equal(resultado.verificacion.resultado_comparacion, "no_coincide");
  assert.equal(resultado.verificacion.requiere_revision_profesional, 1);
  assert.equal(db.prepare("SELECT estado FROM tomas_programadas WHERE id = ?").get(toma.id).estado, "no_coincide");
});

test("medicación: una foto ilegible queda no_se_puede_confirmar", async () => {
  const crear = await request("/api/v1/pacientes/SYN-ETC-0001/medicacion/demo/toma-hoy", { method: "POST", body: {} }, tokens.paciente);
  const toma = (await crear.json()).toma;
  const formulario = new FormData();
  formulario.append("imagen", new Blob(["foto-demo"], { type: "image/jpeg" }), "foto.jpg");
  formulario.append("demoResultado", "no_se_puede_confirmar");
  const foto = await fetch(`${base}/api/v1/medicacion/tomas/${toma.id}/foto`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokens.paciente}` },
    body: formulario,
  });
  assert.equal(foto.status, 201);
  const resultado = await foto.json();
  assert.equal(resultado.verificacion.resultado_comparacion, "no_se_puede_confirmar");
});

test("supresión anonimiza y conserva la auditoría", async () => {
  const respuesta = await request("/api/v1/pacientes/SYN-ETC-0001/supresion", { method: "POST", body: {} }, tokens.paciente);
  assert.equal(respuesta.status, 202);
  const paciente = db.prepare("SELECT nombre_ficticio, comuna_ficticia FROM pacientes WHERE id = 'SYN-ETC-0001'").get();
  assert.notEqual(paciente.nombre_ficticio, "María G.");
  assert.ok(db.prepare("SELECT 1 FROM auditoria_acceso WHERE recurso = 'mi-cuenta/SYN-ETC-0001' AND accion = 'eliminacion'").get());
});
