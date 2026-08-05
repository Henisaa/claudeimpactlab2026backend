import { Router } from "express";
import { db } from "../db.js";
import { auditar } from "../auditoria.js";
import { soloRoles } from "../auth.js";
import { procesarOutbox } from "./cpo24.js";

export const rutasAdmin = Router();

rutasAdmin.get("/admin/auditoria", soloRoles("admin"), (req, res) => {
  const limite = Math.min(Number(req.query.limite) || 200, 1000);
  res.json({ auditoria: db.prepare("SELECT * FROM auditoria_acceso ORDER BY timestamp DESC LIMIT ?").all(limite) });
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
