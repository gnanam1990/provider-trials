# Provider Trials · Technical design

## Architecture and ownership

Preserve an established target repo's stack and conventions. For a greenfield target the proposed baseline is a typed HTTP application, PostgreSQL, a supervised background worker and a role-aware web console. Use object storage for large evidence, opaque references in the database, and server-side authorization on retrieval. A transaction writes a domain decision and its outbox row together. A worker processes external side effects and stores a durable result independently of the browser session.

**Actors.** A procurement lead defines a buyer-private benchmark. A dataset steward approves representative inputs and truth labels. A provider operator proves control over a service endpoint. A runner procures measured executions and buyer analysts inspect comparison reports.

## Domain schema

Provider(id,owner_subject,endpoint_origin,key_id), Binding(id,provider_id,origin,nonce,expiry,proof_digest), Suite(id,version,manifest_hash,normalizer_version,consent_policy), Sample(suite_version,id,content_hash,label_hash), Trial(id,suite_version,account_id,budget_minor,asset,cutoff), Cell(trial_id,provider_id,binding_id,sample_id,attempt_id,state), Measurement(cell_id,cost_minor,duration_ms,field_results), Report(id,trial_id,asof_cursor). Unique logical cell; attempt records retain retries and their costs. Pin binding_id, origin, key version and evidence digest on each attempt and retain the contributing binding references in its report.

Index tenant-scoped business keys, workflow status and pending work. Version migrations and test forward migration from a populated previous schema. Write quantities and currency using explicit units and integer minor or token units. Persist the precision alongside provider amounts. A comparison involving different currencies requires an explicit valuation source and timestamp.

## HTTP and worker boundaries

POST /providers/{id}/challenges; POST /providers/{id}/bindings; POST /suites/{id}/versions; POST /trials; POST /trials/{id}/run; GET /trials/{id}/coverage; GET /trials/{id}/reports; GET /reports/{id}/fields. Freeze configuration when running, and require ownership and buyer roles for the respective writes.

Apply tenant membership and action scope on the server. Use a durable idempotency key on commands that can trigger work or payment. An identical retry returns the stored operation reference. A different payload under the same key yields a conflict. Keep polling and webhooks causally tied to the original operation. Apply provider signature verification when supported and reject unverified callbacks as evidence of settlement.

## Decision procedure

Verify that the enrolled principal signs a short-lived challenge including endpoint origin and also serves the nonce at the declared origin. Revalidate after origin/key rotation. Freeze label and sample hashes. Normalize Unicode, dates and fixed-point amounts with explicit locale rules; compare typed fields. Require all mandatory fields correct for an accepted invoice. Count timeout/error as an unaccepted scheduled sample. Show unattempted quota gaps separately; no cross-provider ranking below coverage threshold. Divide all verified charged execution costs, retries included, by accepted invoice count; zero accepted yields undefined. Never migrate prior evidence to a rotated endpoint or key. Expire the previous binding for new dispatch and require fresh enrollment before comparing new measurements.

## State model

Provider unverified → bound → expired/revoked; suite draft → frozen; trial planned → running → complete/partial/cancelled. A completed run can produce low-quality results. Cell unscheduled/reserved/dispatched/succeeded/failed/uncertain. Reports are immutable snapshots of a declared evidence cutoff.

## Recovery

Persist a unique trial/provider/sample slot and durable attempts before paid dispatch. Recover original invocation on timeout where supported; otherwise preserve an uncertain charge. Separate retry policy from logical sample totals and aggregate spend across all attempts. Rebuild a report from its frozen source cursor.

Use a compare-and-set version or row lock for conflicting decisions. Persist an intent before dispatch. If the provider cannot establish what happened, expose a pending-reconciliation state and stop automatic redispatch. Reconcile with the original provider reference, exact amount and scope. Maintain append-only corrections where users depend on the original evidence.

## Operations and integration

Record operation ID, actor role, decision code, latency and the external reference in access-controlled logs. Track stalled operations by age and surface them to the responsible role. Run migrations before workers, test a process restart during an in-flight request, and check convergence from an independently restored database. Deploy web and worker with separate credentials. See [the integration contract](KITE-AND-PROVIDERS.md) and [the tests](TEST-PLAN.md).
