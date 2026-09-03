// Manual/local DB init. Opening the db (db/db.js) already runs the schema + admin seed
// via init-schema.js, so this just triggers that and reports. Safe to run repeatedly.
require("dotenv").config();
require("./db");
console.log("[init] schema ready");
