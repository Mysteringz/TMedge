#!/bin/bash
#SBATCH --job-name=resnet-smoke
#SBATCH --partition=gpu
#SBATCH --time=0-06:00:00
#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --gres=gpu:2
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err

set -euo pipefail
# Keep the result even on clusters where sacct accounting is disabled.
tm_job_finished() {
  local code=$?
  trap - EXIT
  local report="$SLURM_SUBMIT_DIR/.tmedge-exit-$SLURM_JOB_ID"
  { printf "TMEDGE_EXIT_V1|%s|%s|%s\n" "$SLURM_JOB_ID" "$code" "$SECONDS" > "$report.tmp" && mv -f -- "$report.tmp" "$report"; } || true
  exit "$code"
}
trap tm_job_finished EXIT

cd "$SLURM_SUBMIT_DIR/code"
# module and conda read unset variables; strict mode resumes after them.
set +u
module purge
module load cuda/12.1
set -u
if command -v python >/dev/null 2>&1; then
  python_bin="$(command -v python)"
elif command -v python3 >/dev/null 2>&1; then
  python_bin="$(command -v python3)"
else
  echo "No Python interpreter found; load a Python module or select a conda environment." >&2
  exit 127
fi
srun --ntasks=1 "$python_bin" -u train.py
