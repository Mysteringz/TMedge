/**
 * The handful of icons the design uses (Phosphor's shapes, redrawn). Inline
 * so the page needs no icon font or script from a CDN, which the CSP would
 * otherwise have to admit.
 */
const base = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const ArrowRight = () => <svg {...base}><path d="M4 12h16M14 6l6 6-6 6" /></svg>;
export const SignOut = () => <svg {...base}><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M16 8l4 4-4 4M9 12h11" /></svg>;
export const Eye = () => <svg {...base}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3.2" /></svg>;
export const EyeSlash = () => <svg {...base}><path d="M4 4l16 16M9.9 5.3A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3.2 3.2 0 0 0 4.2 4.2" /></svg>;
