const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
require("dotenv").config();

const dbPath = process.env.DB_PATH || "./data/owna.db";
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

module.exports = db;
