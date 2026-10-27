"""
Run goal forecasts through RealityStream's pipeline.

    python models/run.py events/next.yaml [--forecast services] [--report-dir models/report]

The event YAML (project/events/<id>.yaml) holds one RealityStream parameters
block per forecast under `forecasts:`. A plain RealityStream parameters file
works too. RealityStream (../realitystream in the webroot) fetches feature and
target files over HTTP; this runner lets the parameters point at local files
instead, resolved relative to the YAML, then calls run_pipeline unchanged.

This folder is a temporary placeholder: RealityStream runs normally go to the
reports repository (run_models.py pushes there with --upload). Results here
are summarized to models/results/<folder>.json for the goals page and MCP server.
"""

import argparse
import json
import sys
from pathlib import Path

import pandas as pd
import yaml

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
WEBROOT = PROJECT.parent
RS = WEBROOT / "realitystream" / "api"
if not RS.exists():
    sys.exit(f"RealityStream not found at {RS}. Check out the realitystream submodule in the webroot.")
sys.path.insert(0, str(RS))
import run_models  # noqa: E402

_remote_fetch = run_models.fetch_csv


def resolve_paths(params, base):
    """Make features/targets paths absolute so the written copy runs from anywhere."""
    for key in ("features", "targets"):
        block = params.get(key) or {}
        path = str(block.get("path") or "")
        if path and not path.startswith(("http://", "https://")) and not Path(path).is_absolute():
            block["path"] = str((base / path).resolve())
    return params


def forecasts_in(yaml_path, only=None):
    """(name, parameters) pairs from an event YAML, or the file itself."""
    doc = yaml.safe_load(yaml_path.read_text()) or {}
    if "forecasts" not in doc:
        return [(yaml_path.stem, doc)]
    picked = [(n, p) for n, p in doc["forecasts"].items() if not only or n == only]
    if not picked:
        sys.exit(f"No forecast '{only}' in {yaml_path}. Choose from: {', '.join(doc['forecasts'])}")
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("yaml", help="Event YAML with forecasts:, or a RealityStream parameters file")
    ap.add_argument("--forecast", help="Run one forecast by name (default: all)")
    ap.add_argument("--report-dir", default=None, help="Default models/report-<forecast>")
    ap.add_argument("--upload", action="store_true", help="Push the run to the reports repository (needs GITHUB_REPORTS_TOKEN)")
    args = ap.parse_args()
    yaml_path = Path(args.yaml).resolve()

    def fetch_csv(url):
        if str(url).startswith(("http://", "https://")):
            return _remote_fetch(url)
        return pd.read_csv(url)

    run_models.fetch_csv = fetch_csv
    params_dir = HERE / "params"
    params_dir.mkdir(exist_ok=True)
    out = HERE / "results"
    out.mkdir(exist_ok=True)

    for name, params in forecasts_in(yaml_path, args.forecast):
        params = resolve_paths(dict(params), yaml_path.parent)
        written = params_dir / f"{params.get('folder', name)}.yaml"
        written.write_text(yaml.safe_dump(params, sort_keys=False))
        report_dir = args.report_dir or str(HERE / f"report-{name}")
        print(f"Forecast {name}: {written.relative_to(PROJECT)}")
        summary = run_models.run_pipeline(str(written), report_dir=report_dir, upload=args.upload)

        folder = summary.get("folder") or params.get("folder") or name
        keep = {k: summary[k] for k in ("folder", "baseline", "settings", "no_smote", "smote", "feature_importance", "cv")
                if k in summary}
        source = yaml_path.relative_to(PROJECT).as_posix() if yaml_path.is_relative_to(PROJECT) else yaml_path.name
        keep["parameters"] = f"{source}#forecasts.{name}" if name != yaml_path.stem else source
        (out / f"{folder}.json").write_text(json.dumps(keep, indent=2, default=str))
        print(f"Summary: {(out / f'{folder}.json').relative_to(PROJECT)}")


if __name__ == "__main__":
    main()
