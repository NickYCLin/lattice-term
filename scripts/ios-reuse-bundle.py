"""Retrieve this repository's existing unsigned bundle for isolated diagnostics."""
import hashlib
import json
import os
import platform
import re
import subprocess
import tarfile
import tempfile
import zipfile
from pathlib import Path


def verify_bundle(directory, source_run, source_sha):
    provenance = json.loads((directory / "provenance.json").read_text())
    archive = directory / "ios-simulator.tar.gz"
    if (provenance["commit"] != source_sha or provenance["runId"] != source_run
            or provenance["signedForDeviceInstallation"] is not False
            or provenance["simulatorArchitecture"] != platform.machine()
            or hashlib.sha256(archive.read_bytes()).hexdigest() != provenance["sha256"][archive.name]):
        raise RuntimeError("Simulator bundle provenance or digest mismatch")
    return archive


def main():
    source_run, source_sha = os.environ["SOURCE_RUN"], os.environ["SOURCE_SHA"]
    repository = os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[0-9]+", source_run) or not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise RuntimeError("An exact source run and full SHA are required")
    def api(path):
        return json.loads(subprocess.run(["gh", "api", f"repos/{repository}/{path}"],
                                        check=True, capture_output=True, text=True, timeout=60).stdout)
    run = api(f"actions/runs/{source_run}")
    if run["path"] != ".github/workflows/ios-verify.yml" or run["status"] != "completed":
        raise RuntimeError("Source must be a completed iOS verification run")
    artifacts = api(f"actions/runs/{source_run}/artifacts?per_page=100")["artifacts"]
    matches = [item for item in artifacts if item["name"] == f"ios-unsigned-release-{source_sha}" and not item["expired"]]
    if not matches:
        raise RuntimeError("Source bundle is unavailable")
    artifact = max(matches, key=lambda item: item["id"])
    with tempfile.TemporaryDirectory(prefix="lattice-ios-bundle-") as temporary:
        directory = Path(temporary)
        packed = directory / "artifact.zip"
        with packed.open("wb") as output:
            subprocess.run(["gh", "api", f"repos/{repository}/actions/artifacts/{artifact['id']}/zip"],
                           check=True, stdout=output, timeout=180)
        with zipfile.ZipFile(packed) as archive:
            for name in ("provenance.json", "ios-simulator.tar.gz"):
                if archive.namelist().count(name) != 1:
                    raise RuntimeError("Unexpected bundle layout")
                (directory / name).write_bytes(archive.read(name))
        verified = verify_bundle(directory, source_run, source_sha)
        output = Path("src-tauri/gen/apple/build/reused-sim")
        output.mkdir(parents=True, exist_ok=False)
        with tarfile.open(verified) as archive:
            if any(Path(member.name).parts[0] != "LatticeTerm.app" for member in archive.getmembers()):
                raise RuntimeError("Unexpected simulator archive root")
            archive.extractall(output, filter="data")
        (output.parent / "diagnostic-source.json").write_text(json.dumps({
            "sourceRun": source_run, "sourceCommit": source_sha, "artifactId": artifact["id"],
            "diagnosticCommit": os.environ["GITHUB_SHA"], "currentBuildAcceptance": False,
        }, indent=2) + "\n")
        print(f"Diagnosis only: source {source_sha}, artifact {artifact['id']}; not current-build acceptance")


if __name__ == "__main__":
    main()
