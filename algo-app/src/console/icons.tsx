/**
 * The handful of icons the design uses (Phosphor's shapes, redrawn). Inline
 * so the page needs no icon font or script from a CDN, which the CSP would
 * otherwise have to admit.
 */
const base = { width: '1em', height: '1em', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const ArrowRight = () => <svg {...base}><path d="M4 12h16M14 6l6 6-6 6" /></svg>;
export const SignOut = () => <svg {...base}><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5M16 8l4 4-4 4M9 12h11" /></svg>;
export const Eye = () => <svg {...base}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3.2" /></svg>;
export const FilePy = () => <svg {...base}><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>;
export const PaperPlaneRight = () => <svg {...base}><path d="M5 4l16 8-16 8 3-8-3-8Z" /><path d="M8 12h8" /></svg>;
export const UploadSimple = () => <svg {...base}><path d="M12 15V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></svg>;
export const FloppyDisk = () => <svg {...base}><path d="M5 4h11l4 4v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" /><path d="M8 4v5h7V4M8 20v-6h8v6" /></svg>;
export const Plus = () => <svg {...base}><path d="M12 5v14M5 12h14" /></svg>;
export const XMark = () => <svg {...base}><path d="M6 6l12 12M18 6 6 18" /></svg>;
export const EyeSlash =() => <svg {...base}><path d="M4 4l16 16M9.9 5.3A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6C3.7 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3.2 3.2 0 0 0 4.2 4.2" /></svg>;
