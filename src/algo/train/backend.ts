/**
 * How a saved job would reach SLURM on HPC2021 (HANDOVER.md rule 6: build
 * behind this so Plan A, B or C can be plugged in).
 *
 * Only the "none" backend exists. Plan A (a per-user VPN tunnel and SSH),
 * Plan B (a pull agent on the user's HPC account) and Plan C (an official
 * HKU route) are M2+ work, and the handover makes M0 a hard gate before any
 * of it: the feasibility spike has to run with a human present and somebody
 * has to choose a plan. The operations a real backend needs (upload, submit,
 * status, log tail, cancel -- §6.5) are added with the first real backend,
 * shaped by what M0 found, rather than guessed at here.
 */
export interface HpcBackend {
  readonly name: 'none';
  /** Why jobs cannot be submitted, for the UI; null once a backend can. */
  readonly unavailable: string | null;
}

export const NO_BACKEND: HpcBackend = {
  name: 'none',
  unavailable: 'Submission to HPC2021 is not switched on yet. It waits on the M0 feasibility spike '
    + '(docs/hpc/m0-checklist.md) and on choosing plan A, B or C. Drafts, uploads and the sbatch preview work now.',
};
