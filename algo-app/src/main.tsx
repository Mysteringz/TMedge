import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './console/Shell.tsx';
import './styles.css';
// Last: it sets how everything above moves.
import './console/motion.css';

const el = document.getElementById('root');
if (!el) throw new Error('no #root');
createRoot(el).render(<StrictMode><Shell /></StrictMode>);
