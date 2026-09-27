import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ApiProvider } from './api/context';
import { ApiClient } from './api/client';
import './styles.css';

// ApiClient reads host + apiKey from storage on every request, so we don't
// need to pass any placeholder values here. Settings updates flow through
// storage and are picked up on the next request.
const api = new ApiClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiProvider client={api}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ApiProvider>
  </StrictMode>
);