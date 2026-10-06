#!/bin/bash
#SBATCH --job-name=occupancy_gbc
#SBATCH --partition=cpu
#SBATCH --time=2:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err
#SBATCH --mail-type=END,FAIL
#SBATCH --mail-user=tmchan@connect.hku.hk

set -euo pipefail

cd "$SLURM_SUBMIT_DIR/code"
# module and conda read unset variables; strict mode resumes after them.
set +u
module purge
set -u
srun python train.py
