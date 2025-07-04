"""
Python 3 API wrapper for Garmin Connect to get your statistics.
Copy most code from https://github.com/cyberjunky/python-garminconnect
"""

import argparse
import asyncio
import os
import sys
import time
import zipfile

import aiofiles
import garth
import httpx
from config import FOLDER_DICT, JSON_FILE, SQL_FILE
from garmin_device_adaptor import add_fake_device_info, fix_heart_rate
from lxml import etree

from utils import get_logger, load_env_config, make_activities_file

logger = get_logger(__name__)

TIME_OUT = httpx.Timeout(240.0, connect=360.0)


def get_garmin_urls(domain="com"):
    """Return Garmin Connect URLs for a given domain."""
    return {
        "SSO_URL_ORIGIN": f"https://sso.garmin.{domain}",
        "SSO_URL": f"https://sso.garmin.{domain}/sso",
        "MODERN_URL": f"https://connectapi.garmin.{domain}",
        "SIGNIN_URL": f"https://sso.garmin.{domain}/sso/signin",
        "UPLOAD_URL": f"https://connectapi.garmin.{domain}/upload-service/upload/",
        "ACTIVITY_URL": f"https://connectapi.garmin.{domain}/activity-service/activity/{{activity_id}}",
    }


class Garmin:
    def __init__(self, secret_string, auth_domain, is_only_running=False):
        """
        Init module
        """
        self.req = httpx.AsyncClient(timeout=TIME_OUT, http2=False)
        domain = "cn" if auth_domain and str(auth_domain).upper() == "CN" else "com"
        self.URL_DICT = get_garmin_urls(domain)

        if domain == "cn":
            garth.configure(domain="garmin.cn")

        self.modern_url = self.URL_DICT.get("MODERN_URL")
        garth.client.loads(secret_string)

        if garth.client.oauth2_token is None:
            raise GarminConnectAuthenticationError(
                "OAuth2 token is not available. Please ensure proper authentication."
            )

        if garth.client.oauth2_token.expired:
            garth.client.refresh_oauth2()

        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36",
            "origin": self.URL_DICT.get("SSO_URL_ORIGIN"),
            "nk": "NT",
            "Authorization": str(garth.client.oauth2_token),
        }
        self.is_only_running = is_only_running
        self.upload_url = self.URL_DICT.get("UPLOAD_URL")
        self.activity_url = self.URL_DICT.get("ACTIVITY_URL")

    async def fetch_data(self, url, retrying=False):
        """
        Fetch and return data
        """
        try:
            response = await self.req.get(url, headers=self.headers)
            if response.status_code == 429:
                raise GarminConnectTooManyRequestsError("Too many requests")
            logger.debug(f"fetch_data got response code {response.status_code}")
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as err:
            logger.error(f"HTTP error occurred: {err}")
            if retrying:
                logger.debug("Relogin without effect: %s", err)
                raise GarminConnectConnectionError("Error connecting") from err
            else:
                logger.debug("Session may have expired, trying to relogin: %s", err)
                # Assuming token refresh is handled by garth automatically on next request
                # Forcing a refresh here if needed:
                # garth.client.refresh_oauth2()
                # self.headers["Authorization"] = str(garth.client.oauth2_token)
                return await self.fetch_data(url, retrying=True)
        except Exception as err:
            logger.exception("An unexpected error occurred during data retrieval.")
            raise GarminConnectConnectionError("Error connecting") from err

    async def get_activities(self, start, limit):
        """
        Fetch available activities
        """
        url = f"{self.modern_url}/activitylist-service/activities/search/activities?start={start}&limit={limit}"
        if self.is_only_running:
            url += "&activityType=running"
        return await self.fetch_data(url)

    async def get_activity_summary(self, activity_id):
        """
        Fetch activity summary
        """
        url = f"{self.modern_url}/activity-service/activity/{activity_id}"
        return await self.fetch_data(url)

    async def download_activity(self, activity_id, file_type="gpx"):
        if file_type == "fit":
            url = f"{self.modern_url}/download-service/files/activity/{activity_id}"
        else:
            url = f"{self.modern_url}/download-service/export/{file_type}/activity/{activity_id}"
        logger.info(f"Download activity from {url}")
        response = await self.req.get(url, headers=self.headers)
        response.raise_for_status()
        return response.read()

    async def upload_activities_original_from_strava(
        self, datas, use_fake_garmin_device=False, fix_hr=False
    ):
        logger.info(
            "Start uploading %d activities to Garmin. use_fake_garmin_device: %s, fix_hr: %s",
            len(datas),
            use_fake_garmin_device,
            fix_hr,
        )
        for data in datas:
            try:
                # Process content in memory
                file_content = b"".join(data.content)
                if use_fake_garmin_device:
                    file_content = add_fake_device_info(file_content)
                if fix_hr:
                    file_content = fix_heart_rate(file_content)
                files = {"file": (os.path.basename(data.filename), file_content)}

                res = await self.req.post(
                    self.upload_url, files=files, headers=self.headers
                )
                res.raise_for_status()

                # Handle successful upload with no content response
                if res.status_code == 204:
                    logger.info(
                        "Garmin upload for %s success with status 204.", data.filename
                    )
                    continue

                try:
                    resp = res.json()["detailedImportResult"]
                    logger.info("Garmin upload success: %s", resp)
                except Exception as e:
                    logger.error(
                        "Failed to parse Garmin response, status: %d, response: %s",
                        res.status_code,
                        res.text,
                    )
                    raise e
            except Exception as e:
                logger.exception("Garmin upload for %s failed: %s", data.filename, e)
                continue
        await self.req.aclose()

    async def upload_activity_from_file(self, file_path):
        logger.info("Uploading %s", file_path)
        try:
            async with aiofiles.open(file_path, "rb") as f:
                file_body = await f.read()

            files = {"file": (os.path.basename(file_path), file_body)}
            res = await self.req.post(
                self.upload_url, files=files, headers=self.headers
            )
            res.raise_for_status()
            resp = res.json()["detailedImportResult"]
            logger.info("Garmin upload success: %s", resp)
        except Exception as e:
            logger.exception("Garmin upload for %s failed: %s", file_path, e)

    async def upload_activities_files(self, files):
        logger.info("Start uploading %d files to Garmin.", len(files))
        await gather_with_concurrency(
            10,
            [self.upload_activity_from_file(file=f) for f in files],
        )
        await self.req.aclose()


class GarminConnectHttpError(Exception):
    pass


class GarminConnectConnectionError(Exception):
    """Raised when communication ended in error."""

    pass


class GarminConnectTooManyRequestsError(Exception):
    """Raised when rate limit is exceeded."""

    pass


class GarminConnectAuthenticationError(Exception):
    """Raised when login returns wrong result."""

    pass


def get_info_text_value(summary_infos, key_name):
    return str(summary_infos.get(key_name, ""))


def create_element(parent, tag, text):
    elem = etree.SubElement(parent, tag)
    elem.text = text
    elem.tail = "\n"
    return elem


def add_summary_info(file_data, summary_infos, fields=None):
    if not summary_infos:
        return file_data
    try:
        root = etree.fromstring(file_data)
        extensions_node = etree.Element("extensions")
        extensions_node.text = "\n"
        extensions_node.tail = "\n"
        if fields is None:
            fields = ["distance", "average_hr", "average_speed"]
        for field in fields:
            create_element(
                extensions_node,
                field,
                get_info_text_value(summary_infos, field),
            )
        root.insert(0, extensions_node)
        return etree.tostring(root, encoding="utf-8", pretty_print=True)
    except etree.XMLSyntaxError as e:
        logger.error("Failed to parse file data: %s", e)
    except Exception:
        logger.exception("Failed to append summary info to file data.")
    return file_data


async def download_garmin_data(
    client, activity_id, file_type="gpx", summary_infos=None
):
    folder = FOLDER_DICT.get(file_type, "gpx")
    try:
        file_data = await client.download_activity(activity_id, file_type=file_type)
        if summary_infos:
            file_data = add_summary_info(file_data, summary_infos.get(activity_id))

        file_path = os.path.join(folder, f"{activity_id}.{file_type}")
        need_unzip = file_type == "fit"
        if need_unzip:
            file_path = os.path.join(folder, f"{activity_id}.zip")

        async with aiofiles.open(file_path, "wb") as fb:
            await fb.write(file_data)

        if need_unzip:
            with zipfile.ZipFile(file_path, "r") as zip_ref:
                for file_info in zip_ref.infolist():
                    zip_ref.extract(file_info, folder)
                    extracted_path = os.path.join(folder, file_info.filename)
                    if file_info.filename.endswith(".fit"):
                        os.rename(
                            extracted_path, os.path.join(folder, f"{activity_id}.fit")
                        )
                    elif file_info.filename.endswith(".gpx"):
                        os.rename(
                            extracted_path,
                            os.path.join(FOLDER_DICT["gpx"], f"{activity_id}.gpx"),
                        )
                    else:
                        os.remove(extracted_path)
            os.remove(file_path)

    except Exception:
        logger.exception("Failed to download activity %s", activity_id)


async def get_activity_id_list(client):
    """Iteratively fetches all activity IDs."""
    start = 0
    limit = 100
    all_ids = []
    while True:
        activities = await client.get_activities(start, limit)
        if not activities:
            break
        ids = [str(a["activityId"]) for a in activities if "activityId" in a]
        all_ids.extend(ids)
        start += limit
    logger.info("Found %d total activities.", len(all_ids))
    return all_ids


async def gather_with_concurrency(n, tasks):
    semaphore = asyncio.Semaphore(n)

    async def sem_task(task):
        async with semaphore:
            return await task

    return await asyncio.gather(*(sem_task(task) for task in tasks))


def get_downloaded_ids(folder):
    if not os.path.exists(folder):
        os.makedirs(folder)
    return {i.split(".")[0] for i in os.listdir(folder) if not i.startswith(".")}


def get_garmin_summary_infos(activity_summary, activity_id):
    try:
        summary_dto = activity_summary["summaryDTO"]
        return {
            "distance": summary_dto.get("distance"),
            "average_hr": summary_dto.get("averageHR"),
            "average_speed": summary_dto.get("averageSpeed"),
        }
    except (KeyError, TypeError) as e:
        logger.warning("Failed to get activity summary for %s: %s", activity_id, e)
        return {}


async def download_new_activities(
    secret_string,
    auth_domain,
    is_only_running,
    file_type,
):
    client = Garmin(secret_string, auth_domain, is_only_running)

    folder = FOLDER_DICT.get(file_type, "gpx")
    downloaded_ids = get_downloaded_ids(folder)

    if file_type == "fit":
        gpx_folder = FOLDER_DICT["gpx"]
        downloaded_gpx_ids = get_downloaded_ids(gpx_folder)
        downloaded_ids.update(downloaded_gpx_ids)

    activity_ids = await get_activity_id_list(client)
    to_generate_garmin_ids = list(set(activity_ids) - downloaded_ids)
    logger.info("%d new activities to be downloaded", len(to_generate_garmin_ids))

    if not to_generate_garmin_ids:
        return [], {}

    to_generate_garmin_id2title = {}
    garmin_summary_infos_dict = {}

    summary_tasks = [client.get_activity_summary(i) for i in to_generate_garmin_ids]
    results = await gather_with_concurrency(10, summary_tasks)

    for i, summary in enumerate(results):
        activity_id = to_generate_garmin_ids[i]
        if summary:
            to_generate_garmin_id2title[activity_id] = summary.get("activityName", "")
            garmin_summary_infos_dict[activity_id] = get_garmin_summary_infos(
                summary, activity_id
            )
        else:
            logger.warning("Could not retrieve summary for activity %s", activity_id)

    start_time = time.time()
    await gather_with_concurrency(
        10,
        [
            download_garmin_data(
                client,
                id,
                file_type=file_type,
                summary_infos=garmin_summary_infos_dict,
            )
            for id in to_generate_garmin_ids
        ],
    )
    logger.info("Download finished. Elapsed %.2f seconds", time.time() - start_time)

    await client.req.aclose()
    return to_generate_garmin_ids, to_generate_garmin_id2title


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "secret_string",
        nargs="?",
        help="secret_string from get_garmin_secret.py or .env.local",
    )
    parser.add_argument(
        "--is-cn",
        dest="is_cn",
        action="store_true",
        help="if garmin account is cn",
    )
    parser.add_argument(
        "--only-run",
        dest="only_run",
        action="store_true",
        help="if is only for running",
    )
    parser.add_argument(
        "--tcx",
        dest="download_file_type",
        action="store_const",
        const="tcx",
        default="gpx",
        help="to download tcx files",
    )
    parser.add_argument(
        "--fit",
        dest="download_file_type",
        action="store_const",
        const="fit",
        default="gpx",
        help="to download fit files",
    )
    options = parser.parse_args()
    secret_string = options.secret_string

    auth_domain = "CN" if options.is_cn else "COM"
    if secret_string is None:
        env_config = load_env_config()
        secret_key = "GARMIN_SECRET_CN" if options.is_cn else "GARMIN_SECRET"
        secret_string = env_config.get(secret_key.lower())
        if not secret_string:
            logger.error(
                f"Missing Garmin secret string. Please provide it as an "
                f"argument or set {secret_key} in .env.local"
            )
            sys.exit(1)

    new_ids, id2title = await download_new_activities(
        secret_string,
        auth_domain,
        options.only_run,
        options.download_file_type,
    )

    if new_ids:
        if options.download_file_type == "fit":
            make_activities_file(
                SQL_FILE,
                FOLDER_DICT["gpx"],
                JSON_FILE,
                file_suffix="gpx",
                activity_title_dict=id2title,
            )
        make_activities_file(
            SQL_FILE,
            FOLDER_DICT.get(options.download_file_type, "gpx"),
            JSON_FILE,
            file_suffix=options.download_file_type,
            activity_title_dict=id2title,
        )


if __name__ == "__main__":
    asyncio.run(main())
