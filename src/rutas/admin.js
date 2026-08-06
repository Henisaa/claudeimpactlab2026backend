import { Router } from "express";
import { db, nuevoId } from "../db.js";
import { auditar } from "../auditoria.js";
import { hashClave, soloRoles } from "../auth.js";
import { procesarOutbox } from "./cpo24.js";

export const rutasAdmin = Router();

rutasAdmin.get("/admin/auditoria", soloRoles("admin"), (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 200, 1000);
  res.json({ auditoria: db.prepare("SELECT * FROM auditoria_acceso ORDER BY timestamp DESC LIMIT ?").all(limite) });
});
rutasAdmin.get("/admin/auditoria/export", soloRoles("admin"), (req, res) => {
  const filas = db.prepare("SELECT * FROM auditoria_acceso ORDER BY timestamp DESC").all();
  const columnas = ["id", "usuario_id", "tipo_usuario", "accion", "recurso", "campo_modificado", "valor_anterior", "valor_nuevo", "timestamp", "ip_address", "user_agent"];
  const csv = [columnas.join(","), ...filas.map((fila) => columnas.map((campo) => csvEscape(fila[campo])).join(","))].join("\n");
  auditar({ usuario: req.usuario, accion: "exportacion", recurso: "admin/auditoria", req });
  res.type("text/csv").send(csv);
});
rutasAdmin.get("/admin/matriz", soloRoles("admin"), (_req, res) => {
  res.json({ filas: db.prepare("SELECT * FROM matriz_clinica ORDER BY version, categoria, id").all() });
});
rutasAdmin.get("/admin/notificaciones", soloRoles("admin"), (_req, res) => {
  res.json({ notificaciones: db.prepare("SELECT * FROM notificaciones_outbox ORDER BY creada_en DESC").all() });
});
rutasAdmin.post("/admin/notificaciones/procesar", soloRoles("admin"), (req, res) => {
  const procesadas = procesarOutbox();
  auditar({ usuario: req.usuario, accion: "modificacion", recurso: "admin/notificaciones", valorNuevo: procesadas, req });
  res.json({ procesadas });
});

rutasAdmin.get("/admin/usuarios", soloRoles("admin"), (_req, res) => {
  const usuarios = db.prepare("SELECT id, username, tipo_usuario, paciente_id, cuidador_id, profesional_id, activo FROM usuarios ORDER BY username").all();
  res.json({ usuarios });
});

rutasAdmin.post("/admin/usuarios", soloRoles("admin"), (req, res) => {
  const body = req.body ?? {};
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  const tipo = body.tipo_usuario ?? body.tipo;
  if (!username || password.length < 8 || !["paciente", "cuidador", "profesional", "admin"].includes(tipo)) return res.status(400).json({ error: "username, password de al menos 8 caracteres y tipo válido son obligatorios." });
  const id = nuevoId("USR");
  try {
    db.prepare("INSERT INTO usuarios (id, username, password_hash, tipo_usuario, paciente_id, cuidador_id, profesional_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, username, hashClave(password), tipo, body.paciente_id ?? body.pacienteId ?? null, body.cuidador_id ?? body.cuidadorId ?? null, body.profesional_id ?? body.profesionalId ?? null);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) return res.status(409).json({ error: "El username ya existe." });
    throw err;
  }
  auditar({ usuario: req.usuario, accion: "escritura", recurso: `admin/usuarios/${id}`, req });
  res.status(201).json({ usuario: { id, username, tipo_usuario: tipo } });
});

rutasAdmin.patch("/admin/usuarios/:usuarioId", soloRoles("admin"), (req, res) => {
  const usuario = db.prepare("SELECT * FROM usuarios WHERE id = ?").get(req.params.usuarioId);
  if (!usuario) return res.status(404).json({ error: "Usuario no encontrado." });
  const cambios = [];
  if (req.body?.username !== undefined) cambios.push(["username", String(req.body.username).trim()]);
  if (req.body?.activo !== undefined) cambios.push(["activo", req.body.activo ? 1 : 0]);
  if (req.body?.tipo_usuario !== undefined) {
    if (!["paciente", "cuidador", "profesional", "admin"].includes(req.body.tipo_usuario)) return res.status(400).json({ error: "Tipo de usuario inválido." });
    cambios.push(["tipo_usuario", req.body.tipo_usuario]);
  }
  if (req.body?.password !== undefined) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    cambios.push(["password_hash", hashClave(String(req.body.password))]);
  }
  for (const [campo, valor] of cambios) {
    db.prepare(`UPDATE usuarios SET ${campo} = ? WHERE id = ?`).run(valor, usuario.id);
    auditar({ usuario: req.usuario, accion: "modificacion", recurso: `admin/usuarios/${usuario.id}`, campo, valorAnterior: campo === "password_hash" ? "[HASH]" : usuario[campo], valorNuevo: campo === "password_hash" ? "[HASH]" : valor, req });
  }
  res.json({ usuario: { id: usuario.id, username: req.body?.username ?? usuario.username, tipo_usuario: req.body?.tipo_usuario ?? usuario.tipo_usuario, activo: req.body?.activo === undefined ? usuario.activo : (req.body.activo ? 1 : 0) } });
});

function csvEscape(valor) { return `"${String(valor ?? "").replaceAll('"', '""')}"`; }
