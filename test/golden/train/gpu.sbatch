#!/bin/bash
#SBATCH --job-name=resnet-smoke
#SBATCH --partition=gpu
#SBATCH --time=0-06:00:00
#SBATCH --cpus-per-task=8
#SBATCH --mem=64G
#SBATCH --gres=gpu:2
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err

set -euo pipefail

cd "$SLURM_SUBMIT_DIR/code"
# module and conda read unset variables; strict mode resumes after them.
set +u
module purge
module load cuda/12.1
set -u
srun python train.py
