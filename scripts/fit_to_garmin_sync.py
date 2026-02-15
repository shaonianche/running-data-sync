import json
import os
from collections import namedtuple
from datetime import datetime, timezone

import httpx
from garmin_fit_sdk import Decoder, Stream

from .config import FIT_FOLDER
from .garmin_sync import Garmin
from .utils import get_logger, load_env_config

logger = get_logger(__name__)

DATE_FORMAT = "%Y-%m-%d %H:%M:%S"


class FitToGarmin(Garmin):
    def __init__(self, secret_string, garmin_auth_domain):
        super().__init__(secret_string, garmin_auth_domain)

    async def upload_activities_fit(self, files):
        logger.info(f"Start uploading {len(files)} FIT files to Garmin...")
        for fit_file_path in files:
            logger.info(f"Uploading {fit_file_path}")
            with open(fit_file_path, "rb") as f:
                file_body = f.read()
            upload_data = {"file": (os.path.basename(fit_file_path), file_body)}

            try:
                res = await self.req.post(self.upload_url, files=upload_data, headers=self.headers)
                res.raise_for_status()
                resp_json = res.json()
                detailed_import_result = resp_json.get("detailedImportResult", {})
                if detailed_import_result:
                    logger.info(f"Garmin upload success: {detailed_import_result}")
                else:
                    logger.warning(f"Garmin upload response missing details: {resp_json}")

            except httpx.HTTPStatusError as e:
                logger.error(f"HTTP error while uploading {fit_file_path}: {e}")
                try:
                    # Try to parse the error response from Garmin
                    error_json = e.response.json()
                    if any("Duplicate Activity" in msg.get("content", "") for msg in error_json.get("messages", [])):
                        logger.warning(f"Skipping duplicate activity: {fit_file_path}")
                        continue  # Skip to the next file
                except json.JSONDecodeError:
                    logger.error("Could not decode error response.")
            except (json.JSONDecodeError, KeyError) as e:
                logger.error(f"Failed to parse Garmin's response for {fit_file_path}: {e}")
            except Exception as e:
                logger.error(f"An unexpected error occurred while uploading {fit_file_path}: {e}")

        await self.req.aclose()


def get_fit_files():
    FitFile = namedtuple("FitFile", ["path", "time_created"])
    fit_files = []
    for filename in os.listdir(FIT_FOLDER):
        if filename.lower().endswith(".fit"):
            fit_files.append(filename)

    fit_files_sorted = sorted(fit_files, reverse=True)
    fit_files_fullpath = [os.path.join(FIT_FOLDER, filename) for filename in fit_files_sorted]
    files = []
    for file_path in fit_files_fullpath:
        stream = Stream.from_file(file_path)
        decoder = Decoder(stream)
        messages, errors = decoder.read()
        time_created = messages["file_id_mesgs"][0]["time_created"]
        # Assume the time in FIT file is UTC
        files.append(FitFile(path=file_path, time_created=time_created.replace(tzinfo=timezone.utc)))
    return files


async def _upload_new_fit_activities(secret_string, garmin_auth_domain):
    garmin_client = FitToGarmin(secret_string, garmin_auth_domain)
    try:
        last_activity = await garmin_client.get_activities(0, 1)
    except Exception as e:
        logger.error(f"Failed to get last activity from Garmin: {e}")
        return

    all_fit_files = get_fit_files()
    upload_files = []
    if not last_activity:
        logger.info("No Garmin activity found, preparing to upload all local files.")
        upload_files = [f.path for f in all_fit_files]
    else:
        after_datetime_str = last_activity[0]["startTimeGMT"]
        after_datetime = datetime.strptime(after_datetime_str, DATE_FORMAT).replace(tzinfo=timezone.utc)
        logger.info(f"Garmin's last activity date: {after_datetime}")
        for fit_file in all_fit_files:
            if after_datetime >= fit_file.time_created:
                # Stop when we find a file that is older or same as the last synced one
                break
            else:
                upload_files.append(fit_file.path)

    if upload_files:
        # The files are currently sorted from newest to oldest.
        # Reversing to upload from oldest to newest.
        upload_files.reverse()
        await garmin_client.upload_activities_fit(upload_files)
    else:
        logger.info("No new activities to upload.")


async def run_fit_to_garmin_sync(secret_string: str | None, is_cn: bool) -> None:
    garmin_auth_domain = "CN" if is_cn else "COM"
    if secret_string is None:
        env_config = load_env_config()
        secret_key = "GARMIN_SECRET_CN" if is_cn else "GARMIN_SECRET"
        if env_config and env_config.get(secret_key.lower()):
            secret_string = env_config[secret_key.lower()]
        else:
            raise ValueError(
                f"Missing Garmin secret string. Please provide it as an argument or set {secret_key} in .env.local"
            )

    await _upload_new_fit_activities(secret_string, garmin_auth_domain)


if __name__ == "__main__":
    from .cli.fit_to_garmin_sync import main

    main()
