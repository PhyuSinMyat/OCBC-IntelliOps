# Shared API clients

`banking.js` loads the shared database snapshot when `VITE_BANKING_API_URL` is set.
All source-record portals then use the same records and server-calculated balance
summaries. Payment operations use controlled authenticated backend APIs and reload
the shared snapshot on success. Connected mode never falls back silently to local data.
The default mode uses persisted synthetic records in `../data/bankingRecords.js`.

`paymentRequest` adds the session's configured demo bearer token. No role or
credential is embedded in the bundle. The backend derives role permissions from
the credential, including the ADMIN restriction on scenario injection.
