import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './components/Toast';
import { DiagramsProvider } from './components/diagrams/DiagramsProvider';
import { PreviewProvider } from './components/preview/PreviewContext';
import App from './App.tsx';
import './index.css';
import { installClientLogging } from './utils/clientLog';

installClientLogging();

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DiagramsProvider>
          <PreviewProvider>
            <App />
          </PreviewProvider>
        </DiagramsProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
