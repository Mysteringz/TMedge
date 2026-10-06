/**
 * What a training job asks HPC2021 for, and the rules every field must pass
 * before any of it reaches a shell (HANDOVER.md §6.2).
 *
 * The sbatch script is rendered from these values, so validation here is
 * half of the injection defence; the other half is shQuote in sbatch.ts.
 * Every string either matches a pattern with no shell metacharacters or is
 * quoted on render, and test/train.test.ts runs hostile input through bash
 * to prove the two halves meet.
 */
import { parseTimeLimit, type HpcConfig } from './config.js';

export interface JobSpec {
  name: string;
  partition: string;
  cpusPerTask: number;
  memGb: number;
  gpus: number;
  timeLimit: string;
  modules: string[];
  condaEnv: string | null;
  /** A .py file in the job's code, relative to its root. */
  entrypoint: string;
  args: string[];
  env: Record<string, string>;
  notifyEmail: boolean;
}

export interface Problem { field: string; message: string }

export const SPEC_FIELDS = ['name', 'partition', 'cpusPerTask', 'memGb', 'gpus', 'timeLimit', 'modules',
  'condaEnv', 'entrypoint', 'args', 'env', 'notifyEmail'] as const;

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
/**
 * The handover's `^[A-Za-z0-9_.-]{1,64}$`, minus a leading dot or dash: `..`
 * or `--help` would pass the original and mean something else to conda.
 */
const CONDA = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const MAX_ARGS = 64;
export const MAX_ARG_LENGTH = 256;
export const MAX_ENV = 32;
export const MAX_ENV_VALUE = 1024;

/**
 * Text that bash can carry byte for byte inside single quotes. NUL cannot be
 * in a shell word at all, and a lone surrogate would arrive as U+FFFD -- not
 * what was typed, so refused rather than silently changed.
 */
function shellSafeText(s: string): boolean {
  return !s.includes('\0') && !LONE_SURROGATE.test(s);
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Checks a spec from the browser against the config and the job's code.
 * `files` is every .py file in the upload; the entrypoint must be one.
 */
export function validateSpec(raw: unknown, cfg: HpcConfig, files: readonly string[]):
  { ok: true; spec: JobSpec } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const bad = (field: string, message: string) => { problems.push({ field, message }); };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problems: [{ field: 'spec', message: 'expected an object' }] };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(SPEC_FIELDS as readonly string[]).includes(k)) bad(k, 'unknown field');

  if (typeof o.name !== 'string' || !NAME.test(o.name)) bad('name', '1-40 letters, digits, _ or -');

  const partition = cfg.partitions.find((p) => p.name === o.partition);
  if (!partition) bad('partition', `one of ${cfg.partitions.map((p) => p.name).join(', ')}`);

  if (!isInt(o.cpusPerTask, 1, 64)) bad('cpusPerTask', 'a whole number from 1 to 64');
  if (!isInt(o.memGb, 1, 512)) bad('memGb', 'a whole number of GB from 1 to 512');
  if (!isInt(o.gpus, 0, 8)) bad('gpus', 'a whole number from 0 to 8');
  else if (o.gpus > 0 && partition && !partition.gpu) bad('gpus', `${partition.name} has no GPUs; pick a GPU partition`);
  else if (partition?.gpu && o.gpus > partition.maxGpus) bad('gpus', `${partition.name} allows at most ${partition.maxGpus}`);

  const seconds = typeof o.timeLimit === 'string' ? parseTimeLimit(o.timeLimit) : null;
  if (seconds === null) bad('timeLimit', 'D-HH:MM:SS or H:MM:SS, more than zero');
  else if (partition && seconds > partition.maxSeconds) bad('timeLimit', `${partition.name} allows at most ${partition.maxTime}`);

  if (!Array.isArray(o.modules) || o.modules.length > 16) bad('modules', 'a list of up to 16 modules');
  else {
    for (const m of o.modules) {
      if (typeof m !== 'string' || !cfg.modules.includes(m)) { bad('modules', `${JSON.stringify(m)} is not in the module allowlist`); break; }
    }
    if (new Set(o.modules).size !== o.modules.length) bad('modules', 'a module is listed twice');
  }

  const conda = o.condaEnv === '' ? null : o.condaEnv;
  if (conda !== null && conda !== undefined && (typeof conda !== 'string' || !CONDA.test(conda))) {
    bad('condaEnv', 'an environment name: letters, digits, _ . - (not starting with . or -)');
  }

  if (typeof o.entrypoint !== 'string' || !o.entrypoint.endsWith('.py')) bad('entrypoint', 'a .py file');
  // Leading "-" would be read by python as an option, not a file.
  else if (o.entrypoint.startsWith('-') || o.entrypoint.startsWith('/')) bad('entrypoint', 'a relative path that does not start with - or /');
  else if (!files.includes(o.entrypoint)) bad('entrypoint', `${o.entrypoint} is not in the uploaded code`);

  if (!Array.isArray(o.args) || o.args.length > MAX_ARGS) bad('args', `a list of up to ${MAX_ARGS} arguments`);
  else if (o.args.some((a) => typeof a !== 'string' || a.length > MAX_ARG_LENGTH || !shellSafeText(a))) {
    bad('args', `each argument is text of at most ${MAX_ARG_LENGTH} characters`);
  }

  if (typeof o.env !== 'object' || o.env === null || Array.isArray(o.env)) bad('env', 'an object of NAME: value');
  else {
    const entries = Object.entries(o.env);
    if (entries.length > MAX_ENV) bad('env', `at most ${MAX_ENV} variables`);
    for (const [k, v] of entries) {
      if (!ENV_KEY.test(k)) { bad('env', `${JSON.stringify(k.slice(0, 70))} is not a variable name (A-Z, 0-9, _)`); break; }
      if (typeof v !== 'string' || v.length > MAX_ENV_VALUE || !shellSafeText(v)) { bad('env', `${k}: text of at most ${MAX_ENV_VALUE} characters`); break; }
    }
  }

  // SLURM mail needs the person's HKU UID (their HPC profile, M4) and proof
  // that HPC2021 delivers it (M0 Q11). Until both, the answer is no.
  if (typeof o.notifyEmail !== 'boolean') bad('notifyEmail', 'true or false');
  else if (o.notifyEmail) bad('notifyEmail', 'email notifications wait on M0 (does HPC2021 deliver SLURM mail?) and the HPC profile');

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    spec: {
      name: o.name as string, partition: o.partition as string,
      cpusPerTask: o.cpusPerTask as number, memGb: o.memGb as number, gpus: o.gpus as number,
      timeLimit: o.timeLimit as string, modules: [...(o.modules as string[])],
      condaEnv: (conda as string | null | undefined) ?? null, entrypoint: o.entrypoint as string,
      args: [...(o.args as string[])],
      // A fresh object: a key like __proto__ from JSON must stay a plain key.
      env: Object.fromEntries(Object.entries(o.env as Record<string, string>)),
      notifyEmail: o.notifyEmail as boolean,
    },
  };
}
