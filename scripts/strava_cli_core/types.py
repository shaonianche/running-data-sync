from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class StravaCredentials:
    client_id: str
    client_secret: str
    refresh_token: str


@dataclass(frozen=True)
class GarminCredentials:
    secret_string: str
    is_cn: bool


@dataclass(frozen=True)
class RuntimeConfig:
    sql_file: Path
    fit_dir: Path
    tcx_dir: Path
    gpx_dir: Path

