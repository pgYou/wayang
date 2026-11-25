import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installRendererLogBridge } from './lib/wayang-api';
import './globals.css';

// Renderer log bridge first (§2.9): anything the renderer logs or crashes on
// afterwards lands in the main process's unified log.
installRendererLogBridge();

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
