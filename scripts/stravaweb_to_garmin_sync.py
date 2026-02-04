from datetime import datetime

from .garmin_sync import Garmin
from .strava_sync import run_strava_sync
from stravaweblib import DataFormat, WebClient

from .utils import get_logger, load_env_config, make_strava_client

logger = get_logger(__name__)


async def upload_to_activities(
    garmin_client,
    strava_client,
    strava_web_client,
    format,
    use_fake_garmin_device,
    fix_hr,
):
    last_activity = await garmin_client.get_activities(0, 1)
    if not last_activity:
        logger.info("no garmin activity")
        filters = {}
    else:
        # is this startTimeGMT must have ?
        after_datetime_str = last_activity[0]["startTimeGMT"]
        after_datetime = datetime.strptime(after_datetime_str, "%Y-%m-%d %H:%M:%S")
        logger.info(f"garmin last activity date: {after_datetime}")
        filters = {"after": after_datetime}
    strava_activities = list(strava_client.get_activities(**filters))
    files_list = []
    logger.info(f"strava activities size: {len(strava_activities)}")
    if not strava_activities:
        logger.info("no strava activity")
        return files_list

    # strava rate limit
    for i in sorted(strava_activities, key=lambda i: int(i.id)):
        try:
            data = strava_web_client.get_activity_data(i.id, fmt=format)
            files_list.append(data)
        except Exception as ex:
            print("get strava data error: ", ex)
    await garmin_client.upload_activities_original_from_strava(files_list, use_fake_garmin_device, fix_hr)
    return files_list


async def run_stravaweb_to_garmin_sync(
    client_id: str | None,
    client_secret: str | None,
    refresh_token: str | None,
    secret_string: str | None,
    strava_jwt: str | None,
    strava_email: str | None,
    strava_password: str | None,
    is_cn: bool,
    use_fake_garmin_device: bool,
    fix_hr: bool,
) -> None:
    if not all([client_id, client_secret, refresh_token]):
        env_config = load_env_config()
        if env_config:
            client_id = client_id or env_config.get("strava_client_id")
            client_secret = client_secret or env_config.get("strava_client_secret")
            refresh_token = refresh_token or env_config.get("strava_refresh_token")
            strava_jwt = strava_jwt or env_config.get("strava_jwt")
            strava_email = strava_email or env_config.get("strava_email")
            strava_password = strava_password or env_config.get("strava_password")

        if not all([client_id, client_secret, refresh_token]):
            raise ValueError(
                "Missing required Strava credentials. Please provide them as arguments or in .env.local file"
            )

    strava_client = make_strava_client(
        client_id,
        client_secret,
        refresh_token,
    )

    if strava_jwt:
        strava_web_client = WebClient(
            access_token=strava_client.access_token,
            jwt=strava_jwt,
        )
    elif strava_email and strava_password:
        strava_web_client = WebClient(
            access_token=strava_client.access_token,
            email=strava_email,
            password=strava_password,
        )
    else:
        raise ValueError("Missing Strava web authentication. Please provide either strava_jwt or strava_email/password")

    garmin_auth_domain = "CN" if is_cn else ""
    if not secret_string:
        logger.info("Secret string is not provided, trying to load from env")
        env_config = load_env_config()
        if env_config:
            secret_string = env_config.get("garmin_secret_cn") if is_cn else env_config.get("garmin_secret")

    if not secret_string:
        raise ValueError("Missing garmin secret string")

    try:
        garmin_client = Garmin(secret_string, garmin_auth_domain)
        await upload_to_activities(
            garmin_client,
            strava_client,
            strava_web_client,
            DataFormat.ORIGINAL,
            use_fake_garmin_device,
            fix_hr,
        )
    except Exception as err:
        print(err)

    run_strava_sync(
        client_id,
        client_secret,
        refresh_token,
    )


if __name__ == "__main__":
    from .cli.stravaweb_to_garmin_sync import main

    main()
