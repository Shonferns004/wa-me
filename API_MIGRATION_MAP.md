# API Migration Map

All existing Nest controllers/routes map 1:1 to Express routers under backend/src/modules/<name>/router.js. Event names and payload structures preserved. OpenAPI export script (scripts/export-openapi.js) is the contract baseline. No route path changes.
