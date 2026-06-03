-- =============================================
-- ONEPARTY BOT — Tabla de reservas (disponibilidad)
-- Ejecutar UNA VEZ en Supabase SQL Editor (proyecto oneparty-bot)
-- =============================================

-- Tabla principal de reservas
CREATE TABLE IF NOT EXISTS reservas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alojamiento TEXT NOT NULL CHECK (alojamiento IN ('chalet_kent', 'villa_bellreguard')),
  fecha_sabado DATE NOT NULL,
  estado TEXT NOT NULL DEFAULT 'confirmada' CHECK (estado IN ('confirmada', 'cancelada')),
  telefono_cliente TEXT,
  nombre_cliente TEXT,
  personas INT,
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Solo puede haber UNA reserva confirmada por alojamiento/fecha
CREATE UNIQUE INDEX IF NOT EXISTS idx_reservas_unica_confirmada
  ON reservas (alojamiento, fecha_sabado)
  WHERE estado = 'confirmada';

-- Búsquedas rápidas por fecha
CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas(fecha_sabado);
CREATE INDEX IF NOT EXISTS idx_reservas_aloj_fecha ON reservas(alojamiento, fecha_sabado);

-- =============================================
-- PRECARGA: Chalet Kent — JULIO 2026 entero ocupado
-- (Diego: "los chalets en julio no quedan")
-- =============================================
INSERT INTO reservas (alojamiento, fecha_sabado, estado, notas) VALUES
  ('chalet_kent', '2026-07-04', 'confirmada', 'Bloqueo inicial — julio no quedan chalets'),
  ('chalet_kent', '2026-07-11', 'confirmada', 'Bloqueo inicial — julio no quedan chalets'),
  ('chalet_kent', '2026-07-18', 'confirmada', 'Bloqueo inicial — julio no quedan chalets'),
  ('chalet_kent', '2026-07-25', 'confirmada', 'Bloqueo inicial — julio no quedan chalets')
ON CONFLICT DO NOTHING;

-- =============================================
-- PRECARGA: Villa Bellreguard — pendiente del calendario que pase Diego
-- =============================================
-- INSERT INTO reservas (alojamiento, fecha_sabado, estado, notas) VALUES
--   ('villa_bellreguard', '2026-MM-DD', 'confirmada', 'desde calendario Diego');
