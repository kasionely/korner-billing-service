import dotenv from "dotenv";
import type { Knex } from "knex";

dotenv.config();

const getConnectionConfig = (environment: "development" | "production") => {
  if (environment === "production") {
    if (process.env.DATABASE_URL || process.env.PROD_DATABASE_URL) {
      return process.env.DATABASE_URL || process.env.PROD_DATABASE_URL;
    }
    return {
      host: process.env.PROD_PGHOST || process.env.PGHOST,
      database: process.env.PROD_PGDB || process.env.PGDB,
      user: process.env.PROD_PGUSER || process.env.PGUSER,
      password: process.env.PROD_PGPASSWORD || process.env.PGPASSWORD,
      port: Number(process.env.PROD_PGPORT || process.env.PGPORT) || 5432,
    };
  }

  if (process.env.DEV_DATABASE_URL) {
    return process.env.DEV_DATABASE_URL;
  }

  return {
    host: process.env.DEV_PGHOST || process.env.PGHOST || "localhost",
    database: process.env.DEV_PGDB || process.env.PGDB,
    user: process.env.DEV_PGUSER || process.env.PGUSER,
    password: process.env.DEV_PGPASSWORD || process.env.PGPASSWORD,
    port: Number(process.env.DEV_PGPORT || process.env.PGPORT) || 5432,
  };
};

const config: { [key: string]: Knex.Config } = {
  development: {
    client: "postgresql",
    connection: getConnectionConfig("development"),
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      tableName: "knex_migrations_billing",
      directory: "./migrations",
    },
    searchPath: ["billing", "public"],
  },
  production: {
    client: "postgresql",
    connection: getConnectionConfig("production"),
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      tableName: "knex_migrations_billing",
      directory: "./migrations",
    },
    searchPath: ["billing", "public"],
  },
};

export default config;
