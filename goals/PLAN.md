# Project Plan

Working list for project/goals, the goal automation page, Worker and MCP
server. Open items carry enough context to resume without re-reading the repo.

Related files: [worker/](worker/) (Cloudflare Worker and MCP server),
[schema/](schema/) (open schemas and crosswalks), [pipeline/](pipeline/)
(data harvest and harmonization), [../models/](../models/) (forecast runs,
a temporary placeholder), event settings in .yaml files.

Status: [x] done, [ ] to do, as GitHub task-list items, which AI agents and
GitHub read as checkboxes. Questions stay [ ] until answered. Plain bullets
are findings and notes, not tasks.

## Initial setup

- [x] Cloudflare Worker with MCP server (JSON-RPC 2.0, Streamable HTTP), zero dependencies

- [x] Generic tool and parameter names that map to CRM tables (accounts, contacts, events, activities, ...)

- [x] Claim-level record schema (JSON Schema plus JSON-LD context) with provenance, origin tag, review state, validity interval

- [x] Crosswalks: claim fields to CRM tables, to Open Referral HSDS, NAICS to HS

- [x] Frontend (index.html, from localsite/start/template): ask, search, county explorer, data quality, model results, tool console

- [x] Data toggle: Toy Data (data/toy) or Live Data (community-data on GitHub, the directory API and MCP), a dropdown at the upper right of each panel that has both

- [x] Live Data by default (data=toy for Toy Data). Live views from an outside API or MCP wait for a "Display ..." button, listing the URLs it calls, unless the browser has the data from the last day. Local Industries shows its pre-pulled directory counts meanwhile, and calls its Toy Data "Pre-pulled Data", since data/toy holds a copy of what its Live Data shows

- [x] Quarterly refresh of the pre-pulled data: .github/workflows/goals-data.yml in the project repo reruns pipeline/county_pipeline.py with --industry-year latest and commits data/toy. Update CloudRoot's project submodule afterward to publish it. The Census population file (co-est2024 in sources.json) still needs its vintage changed by hand each year

- [x] Mount the Worker in CloudRoot's Worker at /api/goals/*

- [x] Scene manifest standard (schema/scene.schema.json)

- [ ] Scene files for the proposal charts (scenes/*.json)

- [x] Upstream directory MCP + REST as the source for search, chat (ask) and county targets, behind generic tools

- [ ] AGENTS.md driven PDF output for flexible proposal generation. Sections of PDF updated rather than entire PDF.

## Location services (MCP)

The Goals tab's checkboxes, its "More services" panel and the Data Services tab all
read [pipeline/services.json](pipeline/services.json): 51 services in 14 categories for
students, teachers, AI coders, veterans and everyone. Each one searches through the
MCP server's generic search_nearby tool (worker/src/nearby.js).

- [x] services.json catalog: audiences, categories, 10 featured services, live / key / planned states

- [x] One generic search for MCP tools, REST APIs and OpenStreetMap (Overpass), configured per service: place needed, variants, prelude, where, unique, relax, field mapping to claim-level records with quality flags

- [x] ZIP or city resolved to a point once, through Zippopotam.us (GeoNames, CC BY 4.0)

- [x] search_services (veteran directory) refactored onto the same path; record ids unchanged

- [x] New MCP tools search_nearby and list_services, the goals://services resource, the nearby_scan prompt, route_query suggestions from each service's keywords, service counts in /health

- [x] Goals tab: 10 checkboxes, checked extras, More services by audience and category; Ask and List services fill one section per checked service, each as it answers

- [x] Data Services tab: the catalog with summaries and publishers; Agents tab: tools by purpose

- [x] 25 live services: jobs (Hacker News hiring posts by city, remote jobs, job centers, employment offices), colleges (College Scorecard), public schools (NCES), makerspaces and libraries (OpenStreetMap), developers (GitHub), research institutions (OpenAlex), NSF awards, Wikipedia places, iNaturalist, museums, treatment (FindTreatment.gov), NPI clinics, HUD housing counselors, food banks, community centers, nonprofits (ProPublica), FEMA declarations, weather alerts, EV charging, veteran directory, job centers and claims representatives

### Recommendations

- [ ] Jobs first: get free keys for USAJOBS (USAJOBS_API_KEY, USAJOBS_EMAIL; already wired, shows "needs key") and CareerOneStop (job listings, American Job Centers, training finder), then add them to worker/scripts/dev.mjs KEYS and deploy-worker.yml secrets. These give radius-based local jobs; the live job services today are city mentions (Hacker News), remote listings and job centers.

- [ ] Run Overpass queries less often: the public servers take 20-40 seconds and often refuse. Options: a scheduled job that saves OpenStreetMap places per metro to data/ (like the county files), a hosted Overpass instance (OVERPASS_URL), or Cloudflare KV caching for a day.

- [ ] Set DATA_GOV_API_KEY (College Scorecard and EV stations fall back to the shared DEMO_KEY, about 30 requests an hour) and GITHUB_TOKEN (10 searches a minute without it). OpenAlex now asks for OPENALEX_API_KEY for more than a small shared daily budget.

- [ ] Teachers: add DonorsChoose classroom projects (by ZIP), NCES private schools and Head Start centers next; consider school district boundaries so results follow a school's attendance area rather than distance.

- [ ] AI coders: pair GitHub developers with meetups and hackathons (Meetup needs OAuth; Devpost has no API) and with the repositories they work on, so collaboration starts from shared projects rather than profiles.

- [ ] Students: link College Scorecard results to programs (CIP codes) and to the Local Industries tab, so a county's largest sectors suggest nearby training.

### Questions to resolve

- [ ] Which audience should the page default to, and which 10 services should be featured for it? Today: tech jobs, remote jobs, job centers, colleges, schools, libraries, makerspaces, developers, research institutions and housing counselors, with the veteran directory checked.

- [ ] Should checked services be part of the link (a services= hash value), so a shared link opens with the same searches?

- [ ] Toy Data applies only to the directory's list; should other services get sample files too, for offline demos and tests?

- [ ] events/next.yaml lost its safety_lines, topinfo and lede in commit 5f6de02 ("Update"), so crisis responses fall back to the 911 line alone. Restore them from bb536b8?

- [ ] Which planned services matter most to the proposal's partners (211, findhelp and VA Facilities need partner agreements or keys)?

## Findings so far (for the proposal and charts)

- naics4 rollups fall short of naics2 establishment counts in 2,407 Southeast county-sector cells (withheld 4-digit cells), which is why naics2 is the source and naics4 only a check.

- State-held-out CV (6 folds, one state each), 2023 industry features:

  - directory-services target: ROC-AUC lr 0.60 +/- 0.25, rfc 0.59 +/- 0.21, xgboost 0.57 +/- 0.20 (high variance: each state's directory is curated differently)

  - IRS-org target: lr 0.71 +/- 0.05, rfc 0.71 +/- 0.03, xgboost 0.67 +/- 0.05

- Feature importance (XGBoost): for directory services, population, construction establishments and agriculture payroll lead; for IRS-coded organizations, manufacturing payroll (a sector the old files lacked), real estate establishments and Other Services employment lead.

## Next steps

- [x] Read corrected naics2 files from GitHub (2023 by default; naics4 rollup kept as a check). Census has not published 2024 County Business Patterns yet; rerun `pipeline/county_pipeline.py --refresh` and the models when it does.

- [ ] [Rerun the pipeline](https://github.com/ModelEarth/project/blob/main/goals/pipeline/county_pipeline.py) and [models](https://github.com/ModelEarth/project/blob/main/models/run.py) once Census publishes 2024 County Business Patterns: `python goals/pipeline/county_pipeline.py --states AL,FL,GA,NC,SC,TN --industry-year 2024 --refresh`, then `python models/run.py events/next.yaml`

- [ ] Replace https://example.org/goals in schema $id and the JSON-LD vocab with the published domain.

- [ ] Add a D1 database for the review queue (worker/migrations/0001_init.sql; wrangler.toml [[d1_databases]]), plus a reviewer view.

- [ ] Confirm the HSDS crosswalk (schema/crosswalk-hsds.csv) with Open Referral, especially service_area for county FIPS.

- [ ] Rate-limit propose_correction and the ask route before announcing the endpoint.

- [ ] Try per-capita and share-of-employment features so population stops dominating.

- [ ] Compare emissions totals with [Drawdown Georgia](https://www.drawdownga.org/)'s [GHG Emissions Tracker](https://www.drawdownga.org/ghg-emissions-tracker/): metric tons CO2e for the state, all 159 counties and over 200 cities, monthly from 2005 and updated quarterly. Its statewide figures come from EIA, DOT and EPA data, spread to counties by population, employment, housing, vehicle miles, forest cover and farm data, so they are estimates, not local inventories. Match our Georgia totals (the GHG indicator in the [state models](https://github.com/ModelEarth/profile/tree/main/state)) to the tracker by year and sector (transportation, industry, buildings, agriculture, forest offsets), and note gaps. The tracker is a Power BI dashboard with no download, so record the figures used and the date they were read.

### Notes

- CloudRoot's worker/src/index.js imports ../../project/goals/worker/src/index.js, so push the project submodule before (or with) the CloudRoot commit that points at it, or CI deploy fails.

- project/models is temporary.

- Add a service: one entry in services.json; only a new kind of upstream needs code. Run `node worker/test/smoke.mjs --only=<id>` to check it.
