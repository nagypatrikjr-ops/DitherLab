import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerAllProcessors } from './core';
import { initLanguage } from './i18n';
import { applyUiScale } from './state/prefs';
import { App } from './ui/App';
import './ui/styles.css';

registerAllProcessors();
initLanguage();
applyUiScale();

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
