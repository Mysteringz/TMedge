/**
 * The batch script a job runs as (HANDOVER.md §6.3), rendered once when the
 * draft is saved and shown to the person as-is: what they preview is the
 * file that will be submitted.
 *
 * Two departures from the handover's template, both so that nothing in the
 * script depends on where $HOME turns out to be on HPC2021:
 *
 * - `--output`/`--error` are relative. SLURM resolves them against the
 *   directory sbatch is run from, and the backend runs it from the job's
 *   remote directory (`cd <dir> && sbatch --parsable job.sbatch`).
 * - The script changes into `"$SLURM_SUBMIT_DIR/code"` instead of a path
 *   baked in at render time.
 *
 * And one for real clusters: module and conda scripts read unset variables,
 * so `set -u` is lifted around them, and `source` and `conda activate` are
 * separate lines -- in `a && b`, a failing `a` does not stop a `set -e`
 * script, so the job would quietly run outside its environment.
 */
import type { JobSpec } from './spec.js';

/** Python's shlex.quote, exactly: safe words pass, everything else is single-quoted. */
export function shQuote(s: string): string {
  if (s === '') return "''";
  if (!/[^\w@%+=:,./-]/.test(s)) return s;
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

export interface RenderOptions {
  /** `--mail-user`; required when the spec asks for email. */
  mailUser?: string;
}

/**
 * Every interpolated value is either validated to a shell-inert pattern by
 * validateSpec (name, partition, time, integers) or passes through shQuote.
 */
export function renderSbatch(spec: JobSpec, opts: RenderOptions = {}): string {
  const lines = [
    '#!/bin/bash',
    `#SBATCH --job-name=${spec.name}`,
    `#SBATCH --partition=${spec.partition}`,
    `#SBATCH --time=${spec.timeLimit}`,
    '#SBATCH --nodes=1',
    '#SBATCH --ntasks=1',
    `#SBATCH --cpus-per-task=${spec.cpusPerTask}`,
    `#SBATCH --mem=${spec.memGb}G`,
  ];
  if (spec.gpus > 0) lines.push(`#SBATCH --gres=gpu:${spec.gpus}`);
  lines.push('#SBATCH --output=slurm-%j.out', '#SBATCH --error=slurm-%j.err');
  if (spec.notifyEmail) {
    if (!opts.mailUser || !/^[a-z0-9]{2,32}@(?:connect\.)?hku\.hk$/.test(opts.mailUser)) {
      throw new Error('notifyEmail needs the HKU address to mail');
    }
    lines.push('#SBATCH --mail-type=END,FAIL', `#SBATCH --mail-user=${opts.mailUser}`);
  }
  lines.push(
    '',
    'set -euo pipefail',
    '# Keep the result even on clusters where sacct accounting is disabled.',
    'tm_job_finished() {',
    '  local code=$?',
    '  trap - EXIT',
    '  local report="$SLURM_SUBMIT_DIR/.tmedge-exit-$SLURM_JOB_ID"',
    '  { printf "TMEDGE_EXIT_V1|%s|%s|%s\\n" "$SLURM_JOB_ID" "$code" "$SECONDS" > "$report.tmp" && mv -f -- "$report.tmp" "$report"; } || true',
    '  exit "$code"',
    '}',
    'trap tm_job_finished EXIT',
    '',
    'cd "$SLURM_SUBMIT_DIR/code"',
  );
  // Only when asked for: a single-node cluster may have no `module` at all,
  // and under set -e a missing command fails the job.
  if (spec.modules.length > 0 || spec.condaEnv) {
    lines.push('# module and conda read unset variables; strict mode resumes after them.', 'set +u');
    if (spec.modules.length > 0) lines.push('module purge', ...spec.modules.map((m) => `module load ${shQuote(m)}`));
    if (spec.condaEnv) lines.push('source "$(conda info --base)/etc/profile.d/conda.sh"', `conda activate ${shQuote(spec.condaEnv)}`);
    lines.push('set -u');
  }
  for (const [k, v] of Object.entries(spec.env)) lines.push(`export ${k}=${shQuote(v)}`);
  // An activated environment's python wins; Ubuntu may ship only python3.
  lines.push(
    'if command -v python >/dev/null 2>&1; then',
    '  python_bin="$(command -v python)"',
    'elif command -v python3 >/dev/null 2>&1; then',
    '  python_bin="$(command -v python3)"',
    'else',
    '  echo "No Python interpreter found; load a Python module or select a conda environment." >&2',
    '  exit 127',
    'fi',
    ['srun --ntasks=1 "$python_bin" -u', shQuote(spec.entrypoint), ...spec.args.map(shQuote)].join(' '), '',
  );
  return lines.join('\n');
}
