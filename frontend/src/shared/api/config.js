// Vite exposes only public frontend configuration. Credentials stay on FastAPI.
export const bankingApiUrl = (import.meta.env?.VITE_BANKING_API_URL || '').trim().replace(/\/$/, '');
export const backendModeRequested = bankingApiUrl.length > 0;
