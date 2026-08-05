/**
 * Autenticación y control de acceso por roles (RBAC de BACKEND_IDEALIZADO §4).
 *
 * Roles: paciente, cuidador, profesional, admin. El token JWT lleva el rol y
 * los ids vinculados; `pacientesVisibles` resuelve qué expedientes puede ver
 * cada uno:
 *   - paciente: solo el suyo.
 *   - cuidador: solo pacientes que lo autorizaron (cuidadores.activo = 1).
 *   - profesional: pacientes con evento quirúrgico en su establecimiento.
 */

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { db } from "./db.js";
import { auditar } from "./auditoria.js";

// Sin secreto por defecto fuera del modo demo: en producción (o con
// DEMO_MODE=false) el servidor no arranca sin JWT_SECRET explícito.
const DEMO = process.env.DEMO_MODE === "true" || process.env.NODE_ENV !== "production";
if (!process.env.JWT_SECRET && !DEMO) {
  throw new Error("JWT_SECRET es obligatorio fuera del modo demo.");
}
const JWT_SECRET = process.env.JWT_SECRET ?? "solo-para-demo-local-change-me";
const DURACION = process.env.JWT_EXPIRES_IN ?? "2h";

export function login(username, password, req) {
  const usuario = db
    .prepare("SELECT * FROM usuarios WHERE username = ? AND activo = 1")
    .get(username);
  if (!usuario || !bcrypt.compareSync(password, usuario.password_hash)) {
    auditar({
      usuario: { id: usuario?.id ?? String(username), tipo: usuario?.tipo_usuario ?? "desconocido" },
      accion: "login_fallido",
      recurso: "auth",
      req,
    });
    return null;
  }
  auditar({
    usuario: { id: usuario.id, tipo: usuario.tipo_usuario },
    accion: "login",
    recurso: "auth",
    req,
  });
  const token = jwt.sign(
    {
      sub: usuario.id,
      tipo: usuario.tipo_usuario,
      pacienteId: usuario.paciente_id,
      cuidadorId: usuario.cuidador_id,
      profesionalId: usuario.profesional_id,
    },
    JWT_SECRET,
    { expiresIn: DURACION },
  );
  return {
    token,
    usuario: {
      id: usuario.id,
      username: usuario.username,
      tipo: usuario.tipo_usuario,
      pacienteId: usuario.paciente_id,
      cuidadorId: usuario.cuidador_id,
      profesionalId: usuario.profesional_id,
    },
  };
}

/** Middleware: exige token válido y deja el usuario en req.usuario. */
export function autenticar(req, res, next) {
  const encabezado = req.get("authorization") ?? "";
  const token = encabezado.startsWith("Bearer ") ? encabezado.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Falta el token de acceso." });
  }
  try {
    const datos = jwt.verify(token, JWT_SECRET);
    req.usuario = {
      id: datos.sub,
      tipo: datos.tipo,
      pacienteId: datos.pacienteId ?? null,
      cuidadorId: datos.cuidadorId ?? null,
      profesionalId: datos.profesionalId ?? null,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}

/** Middleware: exige uno de los roles indicados. */
export function soloRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.usuario?.tipo)) {
      return res.status(403).json({ error: "Tu rol no permite esta acción." });
    }
    next();
  };
}

/** Ids de pacientes que este usuario puede ver, según su rol. */
export function pacientesVisibles(usuario) {
  switch (usuario.tipo) {
    case "paciente":
      return usuario.pacienteId ? [usuario.pacienteId] : [];
    case "cuidador": {
      const filas = db
        .prepare(
          `SELECT paciente_id FROM cuidadores
           WHERE id = ? AND activo = 1 AND consentimiento_paciente = 1`,
        )
        .all(usuario.cuidadorId);
      return filas.map((f) => f.paciente_id);
    }
    case "profesional": {
      const filas = db
        .prepare(
          `SELECT DISTINCT e.paciente_id
           FROM eventos_quirurgicos e
           JOIN profesionales p ON p.establecimiento_id = e.establecimiento_id
           WHERE p.id = ?`,
        )
        .all(usuario.profesionalId);
      return filas.map((f) => f.paciente_id);
    }
    default:
      return []; // admin no ve datos clínicos (matriz de permisos §4.2)
  }
}

/** Middleware de propiedad: el :pacienteId de la ruta debe ser visible. */
export function exigirAccesoAPaciente(req, res, next) {
  const pacienteId = req.params.pacienteId;
  if (!pacientesVisibles(req.usuario).includes(pacienteId)) {
    return res
      .status(403)
      .json({ error: "No tienes autorización sobre este paciente." });
  }
  next();
}

/** Consentimiento vigente de un tipo dado (último registro manda). */
export function consentimientoVigente(pacienteId, tipo) {
  const fila = db
    .prepare(
      `SELECT otorgado FROM consentimientos
       WHERE paciente_id = ? AND tipo = ?
       ORDER BY fecha DESC, rowid DESC LIMIT 1`,
    )
    .get(pacienteId, tipo);
  return fila?.otorgado === 1;
}

export function exigirTratamiento(req, res, next) {
  const pacienteId = req.params.pacienteId ?? req.body?.pacienteId;
  if (!pacienteId || !consentimientoVigente(pacienteId, "tratamiento_datos")) {
    return res.status(403).json({ error: "Falta el consentimiento de tratamiento de datos." });
  }
  next();
}

/** Middleware: bloquea si falta un consentimiento (Decreto 31 / Ley 21.719). */
export function exigirConsentimiento(tipo) {
  return (req, res, next) => {
    const pacienteId = req.params.pacienteId ?? req.body?.pacienteId;
    if (!pacienteId || !consentimientoVigente(pacienteId, tipo)) {
      return res.status(403).json({
        error: `Falta el consentimiento "${tipo}" del paciente. Debe otorgarse antes de continuar.`,
        consentimientoRequerido: tipo,
      });
    }
    next();
  };
}

export function hashClave(clave) {
  return bcrypt.hashSync(clave, 10);
}
