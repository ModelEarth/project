"""
Project Goals county pipeline.

Pulls external sources named in pipeline/sources.json (the upstream
veteran resource directory API, pre-processed county industry levels, and
federal files), builds claim-level records for veteran-serving
organizations, flags patterns that point to incorrect or missing data, and
writes county features and targets in the format RealityStream reads (one
row per county FIPS). Any source can be swapped in sources.json.

    python pipeline/county_pipeline.py --states GA
    python pipeline/county_pipeline.py --states GA,AL,FL,NC,SC,TN
    python pipeline/county_pipeline.py --states GA --industry-source cbp --industry-year 2023

Outputs go to data/<scope>/ (scope is the joined state list, e.g. GA or
AL-FL-GA-NC-SC-TN). data/ is not committed except data/toy/:

    ../records/<ST>.json  Claim-level records, one file per state (schema/record.schema.json)
    county-features.csv   Fips, Name, Population, Emp-XX, Est-XX, Pay-XX ...
    county-targets.csv    Fips, Target: top quartile of directory services per 10k people
    county-targets-orgs.csv  Fips, Target: top quartile of IRS-coded veteran organizations per 10k
    county-summary.csv    Counts, rates and coverage state per county
    quality-flags.csv     One row per flag raised on a record or county
    quality-summary.json  Flag counts, for charts and the MCP get_data_quality tool
    manifest.json         Sources used, retrieval times, SHA-256 checksums

Only the standard library is used. Downloads are cached in pipeline/cache/
(not committed). Set CENSUS_API_KEY to add veteran population from the
American Community Survey; without it that column is left empty.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = HERE / "cache"
SOURCES = json.loads((HERE / "sources.json").read_text())["sources"]
SOURCE = {s["source_id"]: s for s in SOURCES}

STATE_FIPS = {
    "AL": "01", "AK": "02", "AZ": "04", "AR": "05", "CA": "06", "CO": "08", "CT": "09", "DE": "10",
    "DC": "11", "FL": "12", "GA": "13", "HI": "15", "ID": "16", "IL": "17", "IN": "18", "IA": "19",
    "KS": "20", "KY": "21", "LA": "22", "ME": "23", "MD": "24", "MA": "25", "MI": "26", "MN": "27",
    "MS": "28", "MO": "29", "MT": "30", "NE": "31", "NV": "32", "NH": "33", "NJ": "34", "NM": "35",
    "NY": "36", "NC": "37", "ND": "38", "OH": "39", "OK": "40", "OR": "41", "PA": "42", "RI": "44",
    "SC": "45", "SD": "46", "TN": "47", "TX": "48", "UT": "49", "VT": "50", "VA": "51", "WA": "53",
    "WV": "54", "WI": "55", "WY": "56", "PR": "72",
}
FIPS_STATE = {v: k for k, v in STATE_FIPS.items()}

# A ZIP whose largest county holds less than this share of its land area is
# flagged as split, and the record's county claim carries that share as its
# confidence.
SPLIT_SHARE = 0.9
# Annual filings older than this many years are flagged as stale.
STALE_YEARS = 3
# Names suggesting a veteran focus, used only to propose candidates whose
# codes don't say so. These never count toward targets.
VETERAN_NAME = re.compile(
    r"\b(VETERANS?|VFW|AMVETS|AMERICAN LEGION|DAV|MILITARY ORDER|PURPLE HEART|"
    r"VIETNAM VETERANS|MARINE CORPS LEAGUE|GOLD STAR|WARRIORS?)\b"
)

# Census publishes manufacturing, retail and transportation as ranges.
SECTOR_OF = {"32": "31", "33": "31", "45": "44", "49": "48"}
SECTOR_LABEL = {"31": "31-33 manufacturing", "44": "44-45 retail", "48": "48-49 transportation"}

NOW = datetime.now(timezone.utc)
STAMP = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Download and cache
# ---------------------------------------------------------------------------

retrievals = []


REFRESH = False
refreshed = set()


def fetch(source_id, filename, url):
    """Download url to cache/filename once; record its checksum for the manifest."""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / filename
    if not path.exists() or (REFRESH and path not in refreshed):
        refreshed.add(path)
        print(f"  downloading {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "goals-pipeline/1.0"})
        with urllib.request.urlopen(req, timeout=300) as resp, open(path, "wb") as out:
            out.write(resp.read())
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    modified = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    retrievals.append({"source_id": source_id, "url": url, "file": filename,
                       "retrieved_at": modified, "sha256": sha, "bytes": path.stat().st_size})
    return path


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def load_zip_county():
    """ZIP (ZCTA) -> (county FIPS, share of the ZIP's land in that county)."""
    path = fetch("census-zcta-county", "tab20_zcta520_county20_natl.txt",
                 SOURCE["census-zcta-county"]["url_template"])
    land = defaultdict(dict)
    with open(path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f, delimiter="|"):
            zcta, county = row["GEOID_ZCTA5_20"], row["GEOID_COUNTY_20"]
            if zcta and county:
                land[zcta][county] = land[zcta].get(county, 0) + int(row["AREALAND_PART"] or 0)
    out = {}
    for zcta, parts in land.items():
        total = sum(parts.values()) or 1
        county, area = max(parts.items(), key=lambda kv: kv[1])
        out[zcta] = (county, round(area / total, 3), len(parts))
    return out


def load_population(states):
    path = fetch("census-pep-county", "co-est2024-alldata.csv", SOURCE["census-pep-county"]["url_template"])
    wanted = {STATE_FIPS[s] for s in states}
    pop, names = {}, {}
    with open(path, encoding="latin-1") as f:
        for row in csv.DictReader(f):
            if row["SUMLEV"] == "050" and row["STATE"] in wanted:
                fips = row["STATE"] + row["COUNTY"]
                pop[fips] = int(row["POPESTIMATE2024"])
                names[fips] = row["CTYNAME"]
    return pop, names


def load_cbp(states, year, level):
    """County industry levels from County Business Patterns.

    Returns {fips: {sector: {"emp", "est", "pay", "emp_nf"}}}, where a missing
    or withheld value stays None rather than becoming 0."""
    yy = str(year)[2:]
    url = SOURCE["census-cbp"]["url_template"].format(year=year, yy=yy)
    path = fetch("census-cbp", f"cbp{yy}co.zip", url)
    wanted = {STATE_FIPS[s] for s in states}
    pattern = re.compile(r"^\d{2}----$" if level == 2 else r"^\d{3}///$")
    out = defaultdict(dict)
    with zipfile.ZipFile(path) as z, z.open(z.namelist()[0]) as raw:
        for row in csv.DictReader(io.TextIOWrapper(raw, encoding="latin-1")):
            if row["fipstate"] not in wanted:
                continue
            naics = row["naics"]
            if naics == "------":
                sector = "total"
            elif pattern.match(naics):
                sector = naics[:level]
            else:
                continue
            fips = row["fipstate"] + row["fipscty"]
            if row["fipscty"] == "999":  # statewide, not a county
                continue

            def num(v):
                return int(v) if v not in ("", "N", "D", "S") else None
            out[fips][sector] = {"emp": num(row["emp"]), "est": num(row["est"]),
                                 "pay": num(row["ap"]), "emp_nf": row["emp_nf"]}
    return out


def source_url(source_id, key, env_name=None):
    src = SOURCE[source_id]
    return os.environ.get(env_name) if env_name and os.environ.get(env_name) else src[key]


def load_industry_community(states, year):
    """County industry levels from the community-data repository on GitHub.

    Reads the naics2 files, which hold each 2-digit sector including the
    hyphenated ones (31-33 manufacturing, 44-45 retail, 48-49 transportation,
    written as 31, 44 and 48). The naics4 files are rolled up as a check: a
    naics2 file missing a range sector falls back to the rollup and is flagged
    (files before October 2026 had this fault), and a rollup well under the
    naics2 count flags withheld 4-digit cells.
    Returns ({fips: {sector: cell}}, source findings)."""
    template = SOURCE["community-industries"]["url_template"]
    out, findings = defaultdict(dict), []
    for st in states:
        published = defaultdict(dict)
        path2 = fetch("community-industries", f"US-{st}-naics2-{year}.csv",
                      template.format(state=st, level=2, year=year))
        with open(path2, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                published[row["Fips"].zfill(5)][row["Naics"].strip()] = {
                    "emp": int(float(row.get("Employees") or 0)), "est": int(float(row.get("Establishments") or 0)),
                    "pay": int(float(row.get("Payroll") or 0)), "emp_nf": ""}
        rolled = defaultdict(lambda: defaultdict(lambda: {"emp": 0, "est": 0, "pay": 0, "emp_nf": ""}))
        path4 = fetch("community-industries", f"US-{st}-naics4-{year}.csv",
                      template.format(state=st, level=4, year=year))
        with open(path4, encoding="utf-8") as f:
            for row in csv.DictReader(f):
                code = (row.get("Naics") or "").strip()
                if len(code) < 2 or not code[:2].isdigit():
                    continue
                cell = rolled[row["Fips"].zfill(5)][SECTOR_OF.get(code[:2], code[:2])]
                for key, col in (("emp", "Employees"), ("est", "Establishments"), ("pay", "Payroll")):
                    cell[key] += int(float(row.get(col) or 0))
        present = {s for c in published.values() for s in c}
        missing = sorted({"31", "44", "48"} - present)
        if missing:
            findings.append({"source_id": "community-industries", "region": st, "flag": "source_missing_sectors",
                             "detail": f"naics2 file for {year} has no rows for sectors {', '.join(SECTOR_LABEL[m] for m in missing)}; rolled up from naics4"})
        for fips in set(published) | set(rolled):
            for sector in set(published.get(fips, {})) | set(rolled.get(fips, {})):
                pub, roll = published.get(fips, {}).get(sector), rolled.get(fips, {}).get(sector)
                if pub is None and sector not in missing:
                    continue
                out[fips][sector] = dict(pub or roll)
                if pub and roll and roll["est"] < 0.8 * pub["est"]:
                    findings.append({"source_id": "community-industries", "region": st, "county_fips": fips,
                                     "flag": "rollup_shortfall",
                                     "detail": f"Sector {sector}: naics4 rows sum to {roll['est']} establishments, naics2 says {pub['est']} (4-digit cells withheld)"})
            out[fips]["total"] = {k: sum(c[k] for c in out[fips].values()) for k in ("emp", "est", "pay")} | {"emp_nf": ""}
    return out, findings


def load_upstream_coverage(states):
    """Resources per county from the upstream directory API (/api/coverage?level=county)."""
    base = source_url("upstream-directory", "api_url", "UPSTREAM_API_URL").rstrip("/")
    counts, attribution = {}, None
    for st in states:
        url = f"{base}/api/coverage?level=county&state={st}"
        path = fetch("upstream-directory", f"upstream-coverage-{st}.json", url)
        data = json.loads(path.read_text())
        meta = (data.get("_meta") or {}).get("publisher") or {}
        attribution = attribution or meta.get("name")
        for c in data.get("counties", []):
            fips = str(c.get("fips_full") or "").zfill(5)
            if fips.strip("0"):
                counts[fips] = {"resources": int(c.get("resource_count") or 0),
                                "completeness": c.get("avg_completeness")}
    return counts, attribution


def load_acs_veterans(states):
    key = os.environ.get("CENSUS_API_KEY")
    if not key:
        print("  CENSUS_API_KEY not set: veteran population column left empty")
        return {}
    vets = {}
    for st in states:
        url = SOURCE["census-acs-veterans"]["url_template"].format(
            year=2023, state_fips=STATE_FIPS[st], CENSUS_API_KEY=key)
        with urllib.request.urlopen(url, timeout=120) as resp:
            rows = json.load(resp)
        head = rows[0]
        for r in rows[1:]:
            d = dict(zip(head, r))
            vets[d["state"] + d["county"]] = int(d["B21001_002E"])
        retrievals.append({"source_id": "census-acs-veterans", "url": url.replace(key, "{CENSUS_API_KEY}"),
                           "retrieved_at": STAMP})
    return vets


def load_irs(state):
    url = SOURCE["irs-eo-bmf"]["url_template"].format(state_lower=state.lower())
    path = fetch("irs-eo-bmf", f"eo_{state.lower()}.csv", url)
    with open(path, encoding="latin-1") as f:
        return list(csv.DictReader(f))


# ---------------------------------------------------------------------------
# Records and quality flags
# ---------------------------------------------------------------------------

def claim(prop, value, source_id, retrieved_at, confidence, origin="source_extracted", **extra):
    c = {"property": prop, "value": value, "source_id": source_id, "retrieved_at": retrieved_at,
         "origin": origin, "review_state": "candidate", "confidence": confidence}
    c.update(extra)
    return c


def build_records(states, zip_county, flags):
    irs_time = {r["file"]: r["retrieved_at"] for r in retrievals if r["source_id"] == "irs-eo-bmf"}
    records = []
    seen = defaultdict(list)
    for st in states:
        rows = load_irs(st)
        retrieved = irs_time.get(f"eo_{st.lower()}.csv") or STAMP
        for r in rows:
            ntee = (r.get("NTEE_CD") or "").strip()
            sub = (r.get("SUBSECTION") or "").strip()
            name = (r.get("NAME") or "").strip()
            coded = ntee.startswith("W30") or sub == "19"
            proposed = not coded and bool(VETERAN_NAME.search(name))
            if not (coded or proposed):
                continue
            ein = r["EIN"].strip()
            rid = f"org:ein:{ein}"
            zip5 = (r.get("ZIP") or "")[:5]
            street = (r.get("STREET") or "").strip()
            origin = "source_extracted" if coded else "rule_proposed"
            base_conf = 0.9 if coded else 0.4
            rec_flags = []

            county = zip_county.get(zip5)
            if county is None:
                rec_flags.append(("zip_unmapped", f"ZIP {zip5} has no ZCTA match (often a PO Box ZIP)"))
                county_fips, share = None, 0.0
            else:
                county_fips, share, n_parts = county
                if FIPS_STATE.get(county_fips[:2]) != st:
                    rec_flags.append(("state_mismatch",
                                      f"ZIP {zip5} lies mainly in {FIPS_STATE.get(county_fips[:2])}, record says {st}"))
                if share < SPLIT_SHARE:
                    rec_flags.append(("zip_split", f"ZIP {zip5} spans {n_parts} counties; largest holds {share:.0%}"))
            if re.match(r"^(P\.?\s?O\.?\s?BOX|POB\b|BOX\b)", street.upper()):
                rec_flags.append(("mailing_only", "Address is a PO Box: a mailing point, not a service location"))
            period = (r.get("TAX_PERIOD") or "").strip()
            if not period:
                rec_flags.append(("no_filing_period", "No tax period on file"))
            elif int(period[:4]) < NOW.year - STALE_YEARS:
                rec_flags.append(("stale_filing", f"Latest tax period {period[:4]}-{period[4:]}"))
            if sub == "19" and not ntee:
                rec_flags.append(("ntee_missing", "Veterans post (subsection 19) with no NTEE activity code"))
            elif sub == "19" and not ntee.startswith("W"):
                rec_flags.append(("code_mismatch",
                                  f"Veterans post (subsection 19) coded NTEE {ntee}, outside the military and veterans group"))
            if proposed:
                rec_flags.append(("name_only", f"Veteran focus inferred from the name only (NTEE {ntee or 'none'}, subsection {sub})"))

            # Every flag lowers confidence a little; none drops a record.
            conf = round(max(0.05, base_conf - 0.08 * len([f for f in rec_flags if f[0] != "ntee_missing"])), 2)
            claims = [
                claim("name", name.title(), "irs-eo-bmf", retrieved, base_conf),
                claim("tax_id", ein, "irs-eo-bmf", retrieved, 0.99),
                claim("address", {"street": street.title(), "locality": (r.get("CITY") or "").title(),
                                  "region": st, "postal_code": zip5}, "irs-eo-bmf", retrieved,
                      0.5 if any(f[0] == "mailing_only" for f in rec_flags) else base_conf),
                claim("category", "peer_support" if coded else "unclassified", "irs-eo-bmf", retrieved,
                      base_conf, origin=origin, evidence={"ntee": ntee, "subsection": sub}),
            ]
            if county_fips:
                claims.append(claim("county_fips", county_fips, "census-zcta-county", STAMP, share,
                                    origin="derived", method="largest land-area share of ZIP"))
            if period:
                claims.append(claim("last_filing_period", f"{period[:4]}-{period[4:]}", "irs-eo-bmf", retrieved, 0.95))
            rec = {
                "id": rid,
                "entity_type": "organization",
                "crm_table": "accounts",
                "name": name.title(),
                "region": st,
                "postal_code": zip5,
                "county_fips": county_fips,
                "category": "peer_support" if coded else "unclassified",
                "origin": origin,
                "review_state": "candidate",
                "confidence": conf,
                "flags": [f[0] for f in rec_flags],
                "claims": claims,
            }
            records.append(rec)
            seen[(re.sub(r"[^A-Z0-9]", "", name.upper()), zip5)].append(rid)
            for code, detail in rec_flags:
                flags.append({"level": "record", "id": rid, "region": st, "county_fips": county_fips or "",
                              "flag": code, "detail": detail})

    by_id = {r["id"]: r for r in records}
    for (norm, zip5), ids in seen.items():
        if len(ids) > 1:
            for rid in ids:
                by_id[rid]["flags"].append("duplicate_name_zip")
                flags.append({"level": "record", "id": rid, "region": by_id[rid]["region"],
                              "county_fips": by_id[rid]["county_fips"] or "", "flag": "duplicate_name_zip",
                              "detail": f"{len(ids)} tax IDs share this name and ZIP"})
    return records


# ---------------------------------------------------------------------------
# County tables
# ---------------------------------------------------------------------------

def write_csv(path, rows, fields):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def quantile(values, q):
    s = sorted(values)
    if not s:
        return 0
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def write_toy_sample(records, states):
    """data/toy/records-<ST>-sample.json: a few records per flag, small enough to commit."""
    toy = ROOT / "data" / "toy"
    toy.mkdir(parents=True, exist_ok=True)
    for st in states:
        mine = [r for r in records if r["region"] == st]
        picked, seen = [], set()
        for flag in sorted({f for r in mine for f in r["flags"]}) + [None]:
            for r in mine:
                if r["id"] in seen or (flag is not None and flag not in r["flags"]) or (flag is None and r["flags"]):
                    continue
                picked.append(r)
                seen.add(r["id"])
                if sum(1 for p in picked if flag is None or flag in p["flags"]) >= 3:
                    break
        (toy / f"records-{st}-sample.json").write_text(json.dumps({
            "schema": "../../schema/record.schema.json", "generated_at": STAMP, "region": st,
            "note": "Toy sample: up to 3 records per quality flag. Full files are written to data/records/ and not committed.",
            "count": len(picked), "records": picked}, indent=1))


def update_index(scope, states, summary):
    """data/index.json: which scope folders and record files exist, for the Worker."""
    path = ROOT / "data" / "index.json"
    index = json.loads(path.read_text()) if path.exists() else {"scopes": {}, "records": []}
    index["scopes"][scope] = {"states": states, "generated_at": summary["generated_at"],
                              "counties": summary["counties"], "records": summary["records"]}
    index["records"] = sorted(set(index["records"]) | set(states))
    index["updated_at"] = summary["generated_at"]
    path.write_text(json.dumps(index, indent=2))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--states", default="GA", help="Comma-separated state codes (default GA)")
    ap.add_argument("--industry-source", choices=("community", "cbp"), default="community",
                    help="community: pre-processed community-data files (default); cbp: Census County Business Patterns zip")
    ap.add_argument("--industry-year", type=int, default=2023, help="County Business Patterns year (default 2023, the latest published)")
    ap.add_argument("--naics-level", type=int, choices=(2, 3), default=2, help="cbp only")
    ap.add_argument("--no-upstream", action="store_true", help="Skip the upstream directory API")
    ap.add_argument("--refresh", action="store_true", help="Download sources again instead of reusing pipeline/cache")
    ap.add_argument("--out", default=None, help="Output folder (default data/<scope>)")
    args = ap.parse_args()
    global REFRESH
    REFRESH = args.refresh

    states = sorted({s.strip().upper() for s in args.states.split(",") if s.strip()})
    bad = [s for s in states if s not in STATE_FIPS]
    if bad:
        sys.exit(f"Unknown state code(s): {', '.join(bad)}")
    scope = "-".join(states)
    out = Path(args.out) if args.out else ROOT / "data" / scope
    out.mkdir(parents=True, exist_ok=True)

    print(f"Goals county pipeline: {scope}")
    zip_county = load_zip_county()
    pop, names = load_population(states)
    year = args.industry_year
    flags = []
    if args.industry_source == "community":
        cbp, findings = load_industry_community(states, year)
        for f in findings:
            flags.append({"level": "source", "id": f["source_id"], "region": f["region"],
                          "county_fips": f.get("county_fips", ""), "flag": f["flag"], "detail": f["detail"]})
    else:
        cbp = load_cbp(states, year, args.naics_level)
    vets = load_acs_veterans(states)
    upstream, attribution = ({}, None) if args.no_upstream else load_upstream_coverage(states)

    records = build_records(states, zip_county, flags)
    in_scope = [r for r in records if r["county_fips"] and r["county_fips"] in pop]
    counted = Counter(r["county_fips"] for r in in_scope if r["origin"] == "source_extracted")
    proposed = Counter(r["county_fips"] for r in in_scope if r["origin"] == "rule_proposed")

    sectors = sorted({s for c in cbp.values() for s in c if s != "total"})
    feature_rows, summary_rows = [], []
    for fips in sorted(pop):
        ind = cbp.get(fips, {})
        row = {"Fips": fips, "Name": names[fips], "Population": pop[fips]}
        noisy, absent = 0, 0
        for s in sectors:
            cell = ind.get(s)
            for col, key in (("Emp", "emp"), ("Est", "est"), ("Pay", "pay")):
                row[f"{col}-{s}"] = "" if cell is None or cell[key] is None else cell[key]
            if cell is None:
                absent += 1
            elif cell["emp_nf"] in ("J", "D", "S"):
                noisy += 1
        feature_rows.append(row)

        n = counted.get(fips, 0)
        rate = round(n / pop[fips] * 10000, 3) if pop[fips] else 0
        up = upstream.get(fips, {"resources": 0, "completeness": None})
        services = up["resources"]
        srate = round(services / pop[fips] * 10000, 3) if pop[fips] else 0
        if upstream and services == 0 and n > 0:
            flags.append({"level": "county", "id": fips, "region": FIPS_STATE[fips[:2]], "county_fips": fips,
                          "flag": "directory_gap",
                          "detail": f"Directory lists no resources here, but IRS files hold {n} coded veteran organizations"})
        if up["completeness"] is not None and services >= 5 and float(up["completeness"]) < 1.5:
            flags.append({"level": "county", "id": fips, "region": FIPS_STATE[fips[:2]], "county_fips": fips,
                          "flag": "thin_records",
                          "detail": f"{services} directory resources with average completeness {up['completeness']}"})
        if n == 0 and services == 0:
            coverage = "unknown"  # no record is not the same as no service
            flags.append({"level": "county", "id": fips, "region": FIPS_STATE[fips[:2]], "county_fips": fips,
                          "flag": "no_records", "detail": "No coded veteran organization found: a coverage gap to verify, not a confirmed absence"})
        else:
            coverage = "observed"
        sec81 = ind.get("81")
        if n > 0 and (sec81 is None or not sec81["est"]):
            flags.append({"level": "county", "id": fips, "region": FIPS_STATE[fips[:2]], "county_fips": fips,
                          "flag": "orgs_without_sector81",
                          "detail": f"{n} veteran organizations on file but County Business Patterns shows no NAICS 81 establishments (membership organizations without payroll aren't counted there)"})
        if noisy:
            flags.append({"level": "county", "id": fips, "region": FIPS_STATE[fips[:2]], "county_fips": fips,
                          "flag": "industry_high_noise", "detail": f"{noisy} industry sectors carry high noise (flag J: 5% or more infused into employment)"})
        if absent:
            flags.append({"level": "county", "id": fips, "region": FIPS_STATE[fips[:2]], "county_fips": fips,
                          "flag": "industry_absent_sectors", "detail": f"{absent} industry sectors not published: zero or withheld, so treat as unknown"})
        summary_rows.append({
            "Fips": fips, "Name": names[fips], "Region": FIPS_STATE[fips[:2]], "Population": pop[fips],
            "Veterans": vets.get(fips, ""),
            "Services": services if upstream else "", "ServicesPer10k": srate if upstream else "",
            "ServiceCompleteness": up["completeness"] if up["completeness"] is not None else "",
            "VeteranOrgs": n, "ProposedOrgs": proposed.get(fips, 0), "OrgsPer10k": rate,
            "VeteransPerOrg": round(vets[fips] / n, 1) if fips in vets and n else "",
            "Coverage": coverage,
            "EmpTotal": (ind.get("total") or {}).get("emp") or "",
            "EstTotal": (ind.get("total") or {}).get("est") or "",
            "PayTotal": (ind.get("total") or {}).get("pay") or "",
        })

    cut = quantile([r["OrgsPer10k"] for r in summary_rows], 0.75)
    org_targets = [{"Fips": r["Fips"], "Target": int(r["OrgsPer10k"] >= cut and r["VeteranOrgs"] > 0)}
                   for r in summary_rows]
    scut = quantile([r["ServicesPer10k"] for r in summary_rows], 0.75) if upstream else None
    target_rows = ([{"Fips": r["Fips"], "Target": int(r["ServicesPer10k"] >= scut and r["Services"] > 0)}
                    for r in summary_rows] if upstream else org_targets)

    feat_fields = ["Fips", "Name", "Population"] + [f"{c}-{s}" for s in sectors for c in ("Emp", "Est", "Pay")]
    write_csv(out / "county-features.csv", feature_rows, feat_fields)
    write_csv(out / "county-targets.csv", target_rows, ["Fips", "Target"])
    write_csv(out / "county-targets-orgs.csv", org_targets, ["Fips", "Target"])
    write_csv(out / "county-summary.csv", summary_rows, list(summary_rows[0].keys()))
    write_csv(out / "quality-flags.csv", flags, ["level", "id", "region", "county_fips", "flag", "detail"])

    write_toy_sample(records, states)
    # Records are kept one file per state, so a run for several states and a
    # run for one of them write the same files.
    rec_dir = ROOT / "data" / "records"
    rec_dir.mkdir(parents=True, exist_ok=True)
    for st in states:
        mine = [r for r in records if r["region"] == st]
        (rec_dir / f"{st}.json").write_text(json.dumps({
            "schema": "../../schema/record.schema.json",
            "generated_at": STAMP, "region": st, "count": len(mine), "records": mine,
        }, separators=(",", ":")))

    flag_counts = Counter(f["flag"] for f in flags)
    summary = {
        "generated_at": STAMP, "scope": scope, "states": states,
        "records": len(records),
        "records_by_origin": dict(Counter(r["origin"] for r in records)),
        "counties": len(summary_rows),
        "counties_observed": sum(1 for r in summary_rows if r["Coverage"] == "observed"),
        "counties_unknown": sum(1 for r in summary_rows if r["Coverage"] == "unknown"),
        "industry_source": args.industry_source, "industry_year": year,
        "target": "directory services per 10k, top quartile" if upstream else "IRS-coded veteran organizations per 10k, top quartile",
        "target_cutoff_services_per_10k": round(scut, 3) if scut is not None else None,
        "target_cutoff_orgs_per_10k": round(cut, 3),
        "directory_resources": sum(u["resources"] for f, u in upstream.items() if f in pop),
        "directory_attribution": attribution,
        "flags": dict(flag_counts.most_common()),
        "records_flagged": sum(1 for r in records if r["flags"]),
        "mean_confidence": round(sum(r["confidence"] for r in records) / max(1, len(records)), 3),
    }
    (out / "quality-summary.json").write_text(json.dumps(summary, indent=2))
    (out / "manifest.json").write_text(json.dumps({
        "generated_at": STAMP, "scope": scope, "pipeline": "pipeline/county_pipeline.py",
        "parameters": {"states": states, "industry_source": args.industry_source, "industry_year": year,
                       "naics_level": 2 if args.industry_source == "community" else args.naics_level,
                       "split_share": SPLIT_SHARE, "stale_years": STALE_YEARS},
        "sources": retrievals,
        "outputs": {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in sorted(out.iterdir()) if p.suffix in (".csv", ".json") and p.name != "manifest.json"},
    }, indent=2))

    update_index(scope, states, summary)
    # Summaries and features are small: keep copies beside the toy records so the
    # page's sample mode can chart them without the live sources.
    toy = ROOT / "data" / "toy" / scope
    toy.mkdir(parents=True, exist_ok=True)
    for name in ("county-summary.csv", "county-features.csv", "quality-summary.json"):
        (toy / name).write_bytes((out / name).read_bytes())
    print(json.dumps(summary, indent=2))
    print(f"Wrote {out.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
