# Project Plan

Working list for project/goals, the goal automation page, Worker and MCP
server. Open items carry enough context to resume without re-reading the repo.

Related files: [worker/](worker/) (Cloudflare Worker and MCP server),
[schema/](schema/) (open schemas and crosswalks), [pipeline/](pipeline/)
(data harvest and harmonization), [../models/](../models/) (forecast runs,
a temporary placeholder), event settings in .yaml files.

## Initial setup

- [x] Cloudflare Worker with MCP server (JSON-RPC 2.0, Streamable HTTP), zero dependencies
- [x] Generic tool and parameter names that map to CRM tables (accounts, contacts, events, activities, ...)
- [x] Claim-level record schema (JSON Schema plus JSON-LD context) with provenance, origin tag, review state, validity interval
- [x] Crosswalks: claim fields to CRM tables, to Open Referral HSDS, NAICS to HS
- [x] Frontend (index.html, from localsite/start/template): ask, search, county explorer, data quality, model results, tool console
- [x] Data toggle: Toy Data (data/toy) or Live Data (community-data on GitHub, the directory API and MCP), a dropdown at the upper right of each panel that has both
- [x] Mount the Worker in CloudRoot's Worker at /api/goals/*
- [x] Scene manifest standard (schema/scene.schema.json)
- [ ] Scene files for the proposal charts (scenes/*.json)
- [x] Upstream directory MCP + REST as the source for search, chat (ask) and county targets, behind generic tools
- [ ] README.md proposal (multi-page, ready for PDF)
- [ ] specs.md

## Findings so far (for the proposal and charts)

- naics4 rollups fall short of naics2 establishment counts in 2,407 Southeast county-sector cells (withheld 4-digit cells), which is why naics2 is the source and naics4 only a check.
- State-held-out CV (6 folds, one state each), 2023 industry features:
  - directory-services target: ROC-AUC lr 0.60 +/- 0.25, rfc 0.59 +/- 0.21, xgboost 0.57 +/- 0.20 (high variance: each state's directory is curated differently)
  - IRS-org target: lr 0.71 +/- 0.05, rfc 0.71 +/- 0.03, xgboost 0.67 +/- 0.05
- Feature importance (XGBoost): for directory services, population, construction establishments and agriculture payroll lead; for IRS-coded organizations, manufacturing payroll (a sector the old files lacked), real estate establishments and Other Services employment lead.

## Next steps

- [x] Read corrected naics2 files from GitHub (2023 by default; naics4 rollup kept as a check). Census has not published 2024 County Business Patterns yet; rerun `pipeline/county_pipeline.py --refresh` and the models when it does.

- CloudRoot's worker/src/index.js imports ../../project/goals/worker/src/index.js, so push the project submodule before (or with) the CloudRoot commit that points at it, or CI deploy fails.
- Write specs.md for MCP
- Replace https://example.org/goals in schema $id and the JSON-LD vocab with the published domain.
- Add a D1 database for the review queue (worker/migrations/0001_init.sql; wrangler.toml [[d1_databases]]), plus a reviewer view.
- Confirm the HSDS crosswalk (schema/crosswalk-hsds.csv) with Open Referral, especially service_area for county FIPS.
- Rate-limit propose_correction and the ask route before announcing the endpoint.
- Try per-capita and share-of-employment features so population stops dominating.
- project/models is temporary. 