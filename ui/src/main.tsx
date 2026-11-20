import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from './components/Toast';
import { DiagramsProvider } from './components/diagrams/DiagramsProvider';
import { SketchProvider } from './components/sketch/SketchProvider';
import { CanvasProvider } from './components/canvas/CanvasProvider';
import { PreviewProvider } from './components/preview/PreviewContext';
import App from './App.tsx';
import { DocsWindowApp } from './components/docs/DocsWindowApp';
import { DatabaseDown } from './components/settings/database/DatabaseDown';
import { isDocsWindow } from './components/docs/docsWindow';
import { PublicPageApp } from './components/docs/PublicPageApp';
import { publicTokenOf } from './components/docs/publicView';
import './index.css';
import { installClientLogging } from './utils/clientLog';

// `?public=<token>`: a public page, read without signing in; it asks the server for that page and nothing else
const publicToken = publicTokenOf();
if (!publicToken) installClientLogging();

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <DiagramsProvider>
          <SketchProvider>
            <CanvasProvider>
              <PreviewProvider>
                {publicToken ? (
                  <PublicPageApp token={publicToken} />
                ) : (
                  <>
                    {isDocsWindow() ? <DocsWindowApp /> : <App />}
                    <DatabaseDown />
                  </>
                )}
              </PreviewProvider>
            </CanvasProvider>
          </SketchProvider>
        </DiagramsProvider>
      </ToastProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
