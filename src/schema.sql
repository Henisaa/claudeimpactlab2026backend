PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS establecimientos (
  id TEXT PRIMARY KEY, nombre TEXT NOT NULL, region TEXT NOT NULL,
  comuna TEXT NOT NULL, tipo TEXT NOT NULL, nivel_atencion TEXT NOT NULL,
  complejidad TEXT, fuente_deis TEXT
);
CREATE TABLE IF NOT EXISTS pacientes (
  id TEXT PRIMARY KEY, nombre_ficticio TEXT NOT NULL,
  rango_edad TEXT NOT NULL CHECK (rango_edad IN ('65-74','75-84','85+')),
  sexo TEXT NOT NULL CHECK (sexo IN ('M','F')), comuna_ficticia TEXT NOT NULL,
  region TEXT NOT NULL,
  tipo_apoyo TEXT NOT NULL CHECK (tipo_apoyo IN ('autonomo','familiar','cuidador')),
  fragilidad INTEGER NOT NULL DEFAULT 0,
  riesgo_nutricional TEXT NOT NULL DEFAULT 'normal' CHECK (riesgo_nutricional IN ('normal','deficit','exceso')),
  consentimiento_activo INTEGER NOT NULL DEFAULT 0,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  actualizado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS profesionales (
  id TEXT PRIMARY KEY, nombre_profesional TEXT NOT NULL,
  registro_profesional TEXT NOT NULL, establecimiento_id TEXT REFERENCES establecimientos(id),
  rol TEXT NOT NULL CHECK (rol IN ('traumatologo','kinesiologo','enfermera','medico_general')),
  activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS cuidadores (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id),
  nombre_ficticio TEXT NOT NULL, relacion TEXT NOT NULL,
  permisos TEXT NOT NULL DEFAULT '{}', consentimiento_paciente INTEGER NOT NULL DEFAULT 0,
  fecha_autorizacion TEXT, activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS usuarios (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  tipo_usuario TEXT NOT NULL CHECK (tipo_usuario IN ('paciente','cuidador','profesional','admin')),
  paciente_id TEXT REFERENCES pacientes(id), cuidador_id TEXT REFERENCES cuidadores(id),
  profesional_id TEXT REFERENCES profesionales(id), activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS eventos_quirurgicos (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id),
  tipo_cirugia TEXT NOT NULL DEFAULT 'Endoprotesis Total de Cadera primaria electiva',
  diagnostico_principal TEXT NOT NULL DEFAULT 'Artrosis de cadera', codigo_CIE10 TEXT NOT NULL DEFAULT 'M16',
  fecha_cirugia TEXT, modalidad TEXT NOT NULL CHECK (modalidad IN ('ambulatoria','hospitalaria')),
  establecimiento_id TEXT REFERENCES establecimientos(id), servicio_clinico TEXT, anestesia TEXT,
  fecha_ingreso TEXT, fecha_alta TEXT, dias_estadia INTEGER, condicion_egreso TEXT,
  profesional_cirujano_id TEXT REFERENCES profesionales(id)
);
CREATE TABLE IF NOT EXISTS indicaciones_alta (
  id TEXT PRIMARY KEY, evento_quirurgico_id TEXT NOT NULL REFERENCES eventos_quirurgicos(id),
  medicamentos TEXT NOT NULL DEFAULT '[]', dosis_indicada TEXT, frecuencia_indicada TEXT,
  duracion_indicada TEXT, curacion_herida TEXT, restricciones_fisicas TEXT, alimentacion TEXT,
  signos_alarma TEXT NOT NULL DEFAULT '[]', canal_contacto TEXT, fecha_proximo_control TEXT,
  fuente TEXT, profesional_indica_id TEXT REFERENCES profesionales(id),
  fecha_indicacion TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conciliacion_farmacologica (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id),
  evento_quirurgico_id TEXT NOT NULL REFERENCES eventos_quirurgicos(id), medicamento TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('previo','nuevo','suspendido')),
  dosis_profesional TEXT, frecuencia_profesional TEXT, duracion_profesional TEXT,
  motivo_cambio TEXT, alergia INTEGER NOT NULL DEFAULT 0, es_sin_receta INTEGER NOT NULL DEFAULT 0,
  confirmacion_comprension INTEGER NOT NULL DEFAULT 0, fuente TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS matriz_clinica (
  id TEXT PRIMARY KEY, procedimiento TEXT NOT NULL DEFAULT 'ETC primaria electiva (M16)',
  categoria TEXT NOT NULL CHECK (categoria IN ('hito','signo_alarma','recomendacion','control')),
  contenido TEXT NOT NULL, nivel_alerta TEXT NOT NULL DEFAULT 'ninguno'
    CHECK (nivel_alerta IN ('roja','amarilla','verde','ninguno')),
  dia_objetivo INTEGER, fuente TEXT NOT NULL, url_fuente TEXT, fecha_fuente TEXT,
  version TEXT NOT NULL DEFAULT '0.1', estado_validacion TEXT NOT NULL DEFAULT 'pendiente_validacion'
    CHECK (estado_validacion IN ('borrador','pendiente_validacion','validada','caducada')),
  revisado_por TEXT REFERENCES profesionales(id)
);
CREATE TABLE IF NOT EXISTS matriz_versiones (
  id TEXT PRIMARY KEY, version TEXT NOT NULL UNIQUE, contenido TEXT NOT NULL,
  fuente TEXT NOT NULL, fecha_fuente TEXT, estado_validacion TEXT NOT NULL DEFAULT 'pendiente_validacion',
  activa INTEGER NOT NULL DEFAULT 0, creada_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS preferencias_accesibilidad (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id),
  letra_grande INTEGER NOT NULL DEFAULT 1, alto_contraste INTEGER NOT NULL DEFAULT 1,
  lectura_voz_alta INTEGER NOT NULL DEFAULT 1, recordatorios INTEGER NOT NULL DEFAULT 1,
  canal_preferido TEXT NOT NULL DEFAULT 'app' CHECK (canal_preferido IN ('app','telefonico','presencial','whatsapp')),
  confirmacion_comprension_requerida INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS seguimientos (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id),
  evento_quirurgico_id TEXT NOT NULL REFERENCES eventos_quirurgicos(id), dia_postoperatorio INTEGER NOT NULL,
  fecha_registro TEXT NOT NULL DEFAULT (datetime('now')), contacto_24h_realizado INTEGER NOT NULL DEFAULT 0,
  orientacion_entregada INTEGER NOT NULL DEFAULT 0, recomendacion_urgencia INTEGER NOT NULL DEFAULT 0,
  dolor_reportado INTEGER CHECK (dolor_reportado BETWEEN 0 AND 10), nauseas INTEGER NOT NULL DEFAULT 0,
  vomitos INTEGER NOT NULL DEFAULT 0, fiebre_reportada INTEGER NOT NULL DEFAULT 0,
  confusion_orientacion INTEGER NOT NULL DEFAULT 0, sangrado INTEGER NOT NULL DEFAULT 0,
  estado_herida TEXT CHECK (estado_herida IN ('normal','inflamada','con_exudado','abierta')),
  movilidad TEXT CHECK (movilidad IN ('sin_cambios','mejorando','empeorando')),
  alimentacion_hidratacion TEXT CHECK (alimentacion_hidratacion IN ('adecuada','parcial','insuficiente')),
  adherencia_medicamentos TEXT CHECK (adherencia_medicamentos IN ('completa','parcial','no_toma')),
  apoyo_cuidador INTEGER NOT NULL DEFAULT 0, control_agendado INTEGER NOT NULL DEFAULT 0,
  necesidad_derivacion INTEGER NOT NULL DEFAULT 0, revision_profesional INTEGER NOT NULL DEFAULT 0,
  registrado_por TEXT NOT NULL CHECK (registrado_por IN ('paciente','cuidador','profesional','sistema')),
  fuente_dato TEXT
);
CREATE TABLE IF NOT EXISTS alertas (
  id TEXT PRIMARY KEY, seguimiento_id TEXT REFERENCES seguimientos(id),
  paciente_id TEXT NOT NULL REFERENCES pacientes(id), matriz_clinica_id TEXT REFERENCES matriz_clinica(id),
  nivel TEXT NOT NULL CHECK (nivel IN ('roja','amarilla','verde')), descripcion TEXT NOT NULL,
  fecha_creacion TEXT NOT NULL DEFAULT (datetime('now')), fecha_atencion TEXT,
  atendida_por TEXT REFERENCES profesionales(id), estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente','en_revision','resuelta','escalada')), accion_tomada TEXT
);
CREATE TABLE IF NOT EXISTS hitos_seguimiento (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id),
  evento_quirurgico_id TEXT NOT NULL REFERENCES eventos_quirurgicos(id),
  tipo_hito TEXT NOT NULL, dia_objetivo INTEGER, estado TEXT NOT NULL DEFAULT 'pendiente',
  fecha_cumplimiento TEXT, fecha_fin_indicada TEXT, profesional_id TEXT REFERENCES profesionales(id),
  matriz_clinica_id TEXT REFERENCES matriz_clinica(id), creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documentos_clinicos (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id), nombre_original TEXT NOT NULL,
  tipo_documento TEXT NOT NULL, ruta_local TEXT, estado_proceso TEXT NOT NULL DEFAULT 'pendiente',
  fecha_subida TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trazabilidad_extraccion (
  id TEXT PRIMARY KEY, documento_id TEXT NOT NULL REFERENCES documentos_clinicos(id), campo TEXT NOT NULL,
  valor_estructurado TEXT, texto_original TEXT, seccion_origen TEXT, confianza_extraccion REAL,
  ambiguedad_detectada TEXT, conflicto_con_otro_doc TEXT, extraido_por TEXT NOT NULL DEFAULT 'claude_api',
  fecha_extraccion TEXT NOT NULL DEFAULT (datetime('now')), revisado_por_profesional INTEGER NOT NULL DEFAULT 0,
  confianza_texto TEXT CHECK (confianza_texto IN ('alta','media','baja')), confirmado INTEGER NOT NULL DEFAULT 0,
  confirmado_por TEXT
);
CREATE TABLE IF NOT EXISTS consentimientos (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('tratamiento_datos','compartir_cuidador','uso_ia','contacto_telefonico')),
  otorgado INTEGER NOT NULL, fecha TEXT NOT NULL DEFAULT (datetime('now')),
  medio TEXT NOT NULL CHECK (medio IN ('app','presencial','telefonico')), version_formulario TEXT NOT NULL,
  formulario_hash TEXT, ip_address TEXT
);
CREATE TABLE IF NOT EXISTS inventario_tratamiento (
  id TEXT PRIMARY KEY, finalidad TEXT NOT NULL, base_legal TEXT NOT NULL,
  categorias_datos TEXT NOT NULL DEFAULT '[]', destinatarios TEXT NOT NULL DEFAULT '[]',
  transferencias_internacionales INTEGER NOT NULL DEFAULT 0, plazo_conservacion TEXT,
  responsable_id TEXT, activo INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS registro_operacion (
  id TEXT PRIMARY KEY, tratamiento_id TEXT NOT NULL REFERENCES inventario_tratamiento(id),
  operacion TEXT NOT NULL, paciente_id TEXT REFERENCES pacientes(id),
  fecha TEXT NOT NULL DEFAULT (datetime('now')), sistema_actor TEXT NOT NULL,
  base_consentimiento INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS auditoria_acceso (
  id TEXT PRIMARY KEY, usuario_id TEXT NOT NULL, tipo_usuario TEXT NOT NULL,
  accion TEXT NOT NULL, recurso TEXT NOT NULL, campo_modificado TEXT,
  valor_anterior TEXT, valor_nuevo TEXT, timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT, user_agent TEXT
);
CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY, paciente_id TEXT REFERENCES pacientes(id), documento_id TEXT REFERENCES documentos_clinicos(id),
  tipo TEXT NOT NULL, fuente TEXT NOT NULL, url_fuente TEXT, seccion TEXT, contenido TEXT NOT NULL,
  fecha_indexado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(chunk_id UNINDEXED, contenido,
  tokenize = "unicode61 remove_diacritics 2");

CREATE TABLE IF NOT EXISTS cpo24_intentos (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id),
  hito_id TEXT REFERENCES hitos_seguimiento(id), numero INTEGER NOT NULL,
  respondio INTEGER NOT NULL DEFAULT 0, canal TEXT NOT NULL DEFAULT 'telefonico',
  registrado_por TEXT NOT NULL, observacion TEXT, creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS notificaciones_outbox (
  id TEXT PRIMARY KEY, paciente_id TEXT REFERENCES pacientes(id), destinatario_tipo TEXT NOT NULL,
  destinatario_id TEXT, canal TEXT NOT NULL, evento TEXT NOT NULL, payload TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviada','fallida','cancelada')),
  intentos INTEGER NOT NULL DEFAULT 0, ultimo_error TEXT, creada_en TEXT NOT NULL DEFAULT (datetime('now')),
  enviada_en TEXT
);
CREATE TABLE IF NOT EXISTS solicitudes_arco (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id), tipo TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente', motivo TEXT, detalle TEXT,
  creada_en TEXT NOT NULL DEFAULT (datetime('now')), procesada_en TEXT, procesada_por TEXT
);
CREATE TABLE IF NOT EXISTS solicitudes_rectificacion (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id), campo TEXT NOT NULL,
  valor_solicitado TEXT, motivo TEXT NOT NULL, estado TEXT NOT NULL DEFAULT 'pendiente',
  creada_en TEXT NOT NULL DEFAULT (datetime('now')), revisada_en TEXT, revisada_por TEXT
);
CREATE TABLE IF NOT EXISTS oposiciones_tratamiento (
  id TEXT PRIMARY KEY, paciente_id TEXT NOT NULL REFERENCES pacientes(id), finalidad TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1, motivo TEXT, creada_en TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alertas_paciente ON alertas(paciente_id);
CREATE INDEX IF NOT EXISTS idx_seguimientos_paciente ON seguimientos(paciente_id);
CREATE INDEX IF NOT EXISTS idx_outbox_estado ON notificaciones_outbox(estado);
