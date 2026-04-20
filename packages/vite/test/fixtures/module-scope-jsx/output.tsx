// @ts-nocheck
import { createRoot } from 'react-dom/client';
import App from './App';

// biome-ignore lint/style/noNonNullAssertion: fixture input
createRoot(document.getElementById('root')!).render(<App />);