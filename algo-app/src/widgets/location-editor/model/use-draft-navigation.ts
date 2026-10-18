import { useEffect, useRef } from 'react';
import { registerNavigationGuard } from '../../../console/router.ts';

/** Protect local draft state on app navigation, browser history, and tab close/reload. */
export function useDraftNavigation(options: {
  draftId: string;
  hasUnsavedChanges(): boolean;
  validateStep(): boolean;
}): void {
  const current = useRef(options);
  current.current = options;
  useEffect(() => {
    const unregister = registerNavigationGuard((to) => {
      const { draftId, hasUnsavedChanges, validateStep } = current.current;
      if (to.startsWith(`/locations/${encodeURIComponent(draftId)}/`)) return validateStep();
      return !hasUnsavedChanges() || window.confirm('Leave this draft and discard unsaved changes? Choose Cancel to keep editing or save your draft first.');
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!current.current.hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { unregister(); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
}
