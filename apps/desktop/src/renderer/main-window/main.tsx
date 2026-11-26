import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installRendererLogBridge } from '@/renderer/shared/lib/wayang-api';
import '@/renderer/shared/globals.css';
import '@/renderer/shared/styles/scrollbar.scss';

// Renderer log bridge first: anything the renderer logs or crashes on
// afterwards lands in the main process's unified log.
installRendererLogBridge();

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
