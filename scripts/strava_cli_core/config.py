from dataclasses import dataclass

from ..config import FIT_FOLDER, GPX_FOLDER, SQL_FILE, TCX_FOLDER
from ..utils import load_env_config
from .types import GarminCredentials, RuntimeConfig, StravaCredentials


@dataclass(frozen=True)
class CredentialInput:
    client_id: str | None = None
    client_secret: str | None = None
    refresh_token: str | None = None
    garmin_secret: str | None = None
    is_cn: bool = False


def get_runtime_config() -> RuntimeConfig:
    return RuntimeConfig(
        sql_file=SQL_FILE,
        fit_dir=FIT_FOLDER,
        tcx_dir=TCX_FOLDER,
        gpx_dir=GPX_FOLDER,
    )


def resolve_strava_credentials(input_data: CredentialInput) -> StravaCredentials:
    env_config = load_env_config() or {}
    client_id = input_data.client_id or env_config.get("strava_client_id")
    client_secret = input_data.client_secret or env_config.get("strava_client_secret")
    refresh_token = input_data.refresh_token or env_config.get("strava_refresh_token")
    if not all([client_id, client_secret, refresh_token]):
        raise ValueError("Missing Strava credentials. Provide args or .env.local values.")
    return StravaCredentials(
        client_id=str(client_id),
        client_secret=str(client_secret),
        refresh_token=str(refresh_token),
    )


def resolve_garmin_credentials(input_data: CredentialInput) -> GarminCredentials:
    env_config = load_env_config() or {}
    secret_string = input_data.garmin_secret
    if not secret_string:
        secret_string = env_config.get("garmin_secret_cn") if input_data.is_cn else env_config.get("garmin_secret")
    if not secret_string:
        raise ValueError("Missing Garmin secret string. Provide it as argument or in .env.local.")
    return GarminCredentials(secret_string=secret_string, is_cn=input_data.is_cn)

