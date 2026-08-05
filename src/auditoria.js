/**
 * Auditoría de accesos (Ley 20.584: registrar quién accedió, qué dato
 * consultó, cuándo y desde dónde). Los registros son de solo inserción:
 * ningún endpoint del API los modifica ni los elimina.
 */

import { db, nuevoId } from "./db.js";

const insertar = db.prepare(`
  INSERT INTO auditoria_acceso
    (id, usuario_id, tipo_usuario, accion, recurso, campo_modificado,
     valor_anterior, valor_nuevo, ip_address, user_agent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function auditar({
  usuario,
  accion,
  recurso,
  campo = null,
  valorAnterior = null,
  valorNuevo = null,
  req = null,
}) {
  insertar.run(
    nuevoId("AUD"),
    usuario?.id ?? "sistema",
    usuario?.tipo ?? "sistema",
    accion,
    recurso,
    campo,
    valorAnterior === null ? null : String(valorAnterior),
    valorNuevo === null ? null : String(valorNuevo),
    req?.ip ?? null,
    req?.get?.("user-agent") ?? null,
  );
}

/** Middleware: audita como lectura todo GET autenticado. */
export function auditarLecturas(req, res, next) {
  if (req.method === "GET" && req.usuario) {
    auditar({
      usuario: req.usuario,
      accion: "lectura",
      recurso: req.originalUrl,
      req,
    });
  }
  next();
}
