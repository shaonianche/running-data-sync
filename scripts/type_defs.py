"""类型定义"""

from dataclasses import dataclass
from typing import Optional, TypedDict


class ActivityDict(TypedDict, total=False):
    """活动数据字典类型"""

    run_id: int
    name: str
    distance: float
    moving_time: int
    elapsed_time: int
    type: str
    subtype: str
    start_date: str
    start_date_local: str
    location_country: Optional[str]
    summary_polyline: Optional[str]
    average_heartrate: Optional[float]
    average_speed: Optional[float]
    elevation_gain: Optional[float]


class FlybyPoint(TypedDict):
    """Flyby 数据点类型"""

    activity_id: int
    time_offset: int
    lat: Optional[float]
    lng: Optional[float]
    alt: Optional[int]
    pace: float
    hr: Optional[int]
    distance: Optional[int]
    cadence: Optional[int]
    watts: Optional[int]


@dataclass
class SyncConfig:
    """同步配置"""

    client_id: str
    client_secret: str
    refresh_token: str
    only_run: bool = False
    force_sync: bool = False


class EnvConfig(TypedDict, total=False):
    """环境配置字典类型"""

    strava_client_id: Optional[str]
    strava_client_secret: Optional[str]
    strava_refresh_token: Optional[str]
    strava_jwt: Optional[str]
    garmin_email: Optional[str]
    garmin_password: Optional[str]
    garmin_is_cn: Optional[str]
    garmin_secret: Optional[str]
    garmin_secret_cn: Optional[str]
    duckdb_encryption_key: Optional[str]
