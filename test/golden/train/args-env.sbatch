#!/bin/bash
#SBATCH --job-name=occupancy_gbc
#SBATCH --partition=cpu
#SBATCH --time=2:00:00
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --output=slurm-%j.out
#SBATCH --error=slurm-%j.err

set -euo pipefail

cd "$SLURM_SUBMIT_DIR/code"
export OMP_NUM_THREADS=4
export WANDB_MODE=offline
export NOTE='a "quoted" $HOME'
srun python src/model.py --data '~/data/seat q3.parquet' --epochs 10 'it'"'"'s' '$(id)'
