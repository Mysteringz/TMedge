BEGIN;
CREATE SCHEMA IF NOT EXISTS training;
CREATE TABLE IF NOT EXISTS training.frames (
  id text PRIMARY KEY,
  sensor_uid text NOT NULL CHECK (sensor_uid ~ '^[0-9a-f]{2}(:[0-9a-f]{2}){5}$'),
  modality text NOT NULL CHECK (modality IN ('thermal', 'rgb')),
  frame_number bigint,
  captured_at timestamptz,
  received_at timestamptz,
  reference_at timestamptz NOT NULL,
  timestamp_basis text NOT NULL CHECK (timestamp_basis IN ('camera_post_encode', 'edge_receive', 'legacy_pair_reference')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  encoding text NOT NULL CHECK (encoding IN ('thermal_u8', 'jpeg')),
  payload bytea NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 = encode(sha256(payload), 'hex')),
  t_min double precision,
  t_step double precision,
  observed jsonb,
  metadata jsonb NOT NULL DEFAULT '{}',
  imported_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((modality = 'thermal' AND encoding = 'thermal_u8' AND width = 32 AND height = 24
    AND octet_length(payload) = 768 AND t_min IS NOT NULL AND t_step IS NOT NULL AND t_step >= 0
    AND t_min NOT IN ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision)
    AND t_step NOT IN ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision))
    OR (modality = 'rgb' AND encoding = 'jpeg' AND t_min IS NULL AND t_step IS NULL
      AND octet_length(payload) > 4 AND substring(payload from 1 for 2) = decode('ffd8','hex')))
);
CREATE INDEX IF NOT EXISTS frames_sensor_time ON training.frames(sensor_uid, reference_at, modality);
CREATE INDEX IF NOT EXISTS frames_time ON training.frames(reference_at);
CREATE TABLE IF NOT EXISTS training.pairs (
  id text PRIMARY KEY,
  thermal_id text NOT NULL REFERENCES training.frames(id),
  rgb_id text NOT NULL REFERENCES training.frames(id),
  skew_ms integer NOT NULL CHECK (skew_ms BETWEEN 0 AND 400),
  mirror boolean NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (thermal_id, rgb_id)
);
-- Composite foreign keys enforce modality even when rows are inserted outside
-- the worker. The fixed default columns keep older INSERT column lists valid.
-- ALTERs also upgrade an already provisioned database; existing malformed rows
-- fail validation and require reviewed repair rather than being silently lost.
CREATE UNIQUE INDEX IF NOT EXISTS frames_id_modality ON training.frames(id, modality);
ALTER TABLE training.pairs ADD COLUMN IF NOT EXISTS thermal_modality text NOT NULL DEFAULT 'thermal';
ALTER TABLE training.pairs ADD COLUMN IF NOT EXISTS rgb_modality text NOT NULL DEFAULT 'rgb';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='training.pairs'::regclass AND conname='pairs_fixed_modalities') THEN
    ALTER TABLE training.pairs ADD CONSTRAINT pairs_fixed_modalities
      CHECK (thermal_modality='thermal' AND rgb_modality='rgb');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='training.pairs'::regclass AND conname='pairs_thermal_modality_fk') THEN
    ALTER TABLE training.pairs ADD CONSTRAINT pairs_thermal_modality_fk
      FOREIGN KEY (thermal_id, thermal_modality) REFERENCES training.frames(id, modality);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='training.pairs'::regclass AND conname='pairs_rgb_modality_fk') THEN
    ALTER TABLE training.pairs ADD CONSTRAINT pairs_rgb_modality_fk
      FOREIGN KEY (rgb_id, rgb_modality) REFERENCES training.frames(id, modality);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='training.frames'::regclass AND conname='frames_finite_thermal_calibration') THEN
    ALTER TABLE training.frames ADD CONSTRAINT frames_finite_thermal_calibration CHECK
      (modality <> 'thermal' OR (t_min IS NOT NULL AND t_step IS NOT NULL AND t_step >= 0
        AND t_min NOT IN ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision)
        AND t_step NOT IN ('NaN'::double precision,'Infinity'::double precision,'-Infinity'::double precision)));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS training.annotations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  frame_id text NOT NULL REFERENCES training.frames(id),
  label_source text NOT NULL,
  label_version text NOT NULL,
  labels jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (frame_id, label_source, label_version)
);
CREATE OR REPLACE VIEW training.ml_samples AS
SELECT p.id AS sample_id, t.sensor_uid, r.reference_at AS sample_at,
  t.captured_at AS thermal_captured_at, t.received_at AS thermal_received_at,
  t.timestamp_basis AS thermal_timestamp_basis, r.captured_at AS rgb_captured_at,
  r.received_at AS rgb_received_at, p.skew_ms, p.mirror, t.frame_number,
  t.payload AS thermal_u8, t.t_min, t.t_step,
  ARRAY(SELECT (t.t_min + get_byte(t.payload, i) * t.t_step)::real
    FROM generate_series(0, 767) AS i ORDER BY i) AS temperatures_c,
  r.payload AS rgb_jpeg, r.width AS rgb_width, r.height AS rgb_height,
  coalesce(t.observed, p.metadata->'source_record'->'observed') AS device_detections, p.metadata
FROM training.pairs p JOIN training.frames t ON t.id = p.thermal_id
JOIN training.frames r ON r.id = p.rgb_id;
COMMIT;
