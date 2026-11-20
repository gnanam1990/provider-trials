// Versioned forward migrations. Applied in order; each runs inside a transaction.
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE accounts(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE members(
  account_id TEXT NOT NULL REFERENCES accounts(id),
  subject TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN
    ('procurement_lead','dataset_steward','provider_operator','runner','analyst')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(account_id, subject, role)
);

CREATE TABLE providers(
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  owner_subject TEXT NOT NULL,
  name TEXT NOT NULL,
  endpoint_origin TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unverified'
    CHECK(state IN ('unverified','bound','expired','revoked')),
  created_at TEXT NOT NULL
);

CREATE TABLE challenges(
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  nonce TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE bindings(
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  origin TEXT NOT NULL,
  nonce TEXT NOT NULL,
  challenge_id TEXT NOT NULL REFERENCES challenges(id),
  proof_digest TEXT NOT NULL,
  key_id TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'valid'
    CHECK(state IN ('valid','expired','revoked','superseded')),
  superseded_by TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX bindings_one_valid
  ON bindings(provider_id) WHERE state='valid';

CREATE TABLE suites(
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  task TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  normalizer_version TEXT NOT NULL,
  normalizer_config_json TEXT NOT NULL,
  consent_policy_json TEXT NOT NULL,
  mandatory_fields_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','frozen')),
  created_at TEXT NOT NULL,
  frozen_at TEXT,
  PRIMARY KEY(id, version)
);

CREATE TABLE blobs(
  ref TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE samples(
  suite_id TEXT NOT NULL,
  suite_version INTEGER NOT NULL,
  sample_id TEXT NOT NULL,
  content_ref TEXT NOT NULL REFERENCES blobs(ref),
  content_hash TEXT NOT NULL,
  label_json TEXT NOT NULL,
  label_hash TEXT NOT NULL,
  allowed_processors_json TEXT NOT NULL,
  consent_note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(suite_id, suite_version, sample_id),
  FOREIGN KEY(suite_id, suite_version) REFERENCES suites(id, version)
);

CREATE TABLE trials(
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  suite_id TEXT NOT NULL,
  suite_version INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  budget_minor INTEGER NOT NULL,
  per_provider_cap_minor INTEGER NOT NULL,
  asset TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK(state IN ('planned','running','complete','partial','cancelled')),
  providers_json TEXT NOT NULL,
  exclusions_json TEXT NOT NULL DEFAULT '[]',
  recurring_json TEXT,
  ranking_min_observations INTEGER NOT NULL DEFAULT 20,
  small_sample_threshold INTEGER NOT NULL DEFAULT 20,
  dispatch_timeout_ms INTEGER NOT NULL DEFAULT 5000,
  idempotency_key TEXT UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE cells(
  trial_id TEXT NOT NULL REFERENCES trials(id),
  provider_id TEXT NOT NULL,
  binding_id TEXT,
  sample_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'planned'
    CHECK(state IN ('planned','reserved','dispatched','succeeded','failed','uncertain','blocked')),
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(trial_id, provider_id, sample_id)
);

CREATE TABLE attempts(
  id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  trial_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('dispatched','succeeded','failed','uncertain')),
  invocation_ref TEXT,
  dispatched_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  cost_minor INTEGER,
  cost_state TEXT NOT NULL DEFAULT 'unpriced'
    CHECK(cost_state IN ('unpriced','verified','uncertain')),
  receipt_id TEXT,
  uncertainty_reason TEXT,
  UNIQUE(trial_id, provider_id, sample_id, seq)
);

CREATE TABLE measurements(
  attempt_id INTEGER PRIMARY KEY REFERENCES attempts(id),
  accepted INTEGER NOT NULL,
  fields_correct INTEGER NOT NULL,
  fields_total INTEGER NOT NULL,
  field_results_json TEXT NOT NULL,
  response_ref TEXT
);

CREATE TABLE receipts(
  id TEXT PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),
  provider_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  asset TEXT NOT NULL,
  digest TEXT NOT NULL,
  signature TEXT NOT NULL,
  verified INTEGER NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE reports(
  id TEXT PRIMARY KEY,
  trial_id TEXT NOT NULL REFERENCES trials(id),
  asof_cursor INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','failed')),
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  decision_code TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE idempotency_keys(
  key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  operation_ref TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  response_json TEXT,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "member_credentials",
    sql: `ALTER TABLE members ADD COLUMN credential_hash TEXT;`,
  },
];
