import { useEffect, useState } from 'react';

export type WizardStep = 'details' | 'sensors' | 'model' | 'review';
const steps: WizardStep[] = ['details', 'sensors', 'model', 'review'];

function readVisited(key: string): WizardStep[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? steps.filter((step) => value.includes(step)) : [];
  } catch { return []; }
}

/** Visits describe navigation, not publication readiness; remember them per draft in this tab. */
export function useWizardProgress(draftId: string, step: WizardStep, ready: boolean): ReadonlySet<WizardStep> {
  const key = `location-wizard-visits:${draftId}`;
  const [visited, setVisited] = useState<WizardStep[]>(() => readVisited(key));
  useEffect(() => {
    if (!ready) return;
    setVisited((current) => current.includes(step) ? current : [...current, step]);
  }, [step, ready]);
  useEffect(() => {
    try { sessionStorage.setItem(key, JSON.stringify(visited)); }
    catch { /* Visit history is optional; in-memory progress still works without browser storage. */ }
  }, [key, visited]);
  return new Set(ready ? [...visited, step] : visited);
}
