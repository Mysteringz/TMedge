import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App.tsx';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('no #root');
createRoot(el).render(<StrictMode><Root /></StrictMode>);
