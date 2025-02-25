import argparse
import asyncio
import os
from datetime import datetime
import sys

from config import FIT_FOLDER, config
from garmin_fit_sdk import Decoder, Stream
from garmin_sync import Garmin


class FitToGarmin(Garmin):
    def __init__(self, secret_string, garmin_auth_domain):
        super().__init__(secret_string, garmin_auth_domain)

    async def upload_activities_fit(self, files):
        print("start upload fit file to garmin ...")
        for fit_file_path in files:
            with open(fit_file_path, "rb") as f:
                file_body = f.read()
            files = {"file": (fit_file_path, file_body)}

            try:
                res = await self.req.post(
                    self.upload_url, files=files, headers=self.headers
                )
                f.close()
            except Exception as e:
                print(str(e))
                continue

            try:
                resp = res.json()["detailedImportResult"]
                print("garmin upload success: ", resp)
            except Exception as e:
                print("garmin upload failed: ", e)

        await self.req.aclose()


def get_fit_files():
    fit_files = []
    for filename in os.listdir(FIT_FOLDER):
        if filename.lower().endswith(".fit"):
            fit_files.append(filename)

    fit_files_sorted = sorted(fit_files, reverse=True)
    fit_files_fullpath = [
        os.path.join(FIT_FOLDER, filename) for filename in fit_files_sorted
    ]
    files = {}
    for file_path in fit_files_fullpath:
        stream = Stream.from_file(file_path)
        decoder = Decoder(stream)
        messages, errors = decoder.read()
        file_id_mesgs_time_created_str = (
            messages["file_id_mesgs"][0]["time_created"]
        ).strftime("%Y-%m-%d %H:%M:%S")
        files[file_path] = (file_path, file_id_mesgs_time_created_str)
    return files


async def main(secret_string, garmin_auth_domain):
    garmin_client = FitToGarmin(secret_string, garmin_auth_domain)
    last_activity = await garmin_client.get_activities(0, 1)
    all_fit_files = get_fit_files()
    upload_file_path = []
    if not last_activity:
        print("no garmin activity")
    else:
        # is this startTimeGMT must have ?
        after_datetime_str = last_activity[0]["startTimeGMT"]
        after_datetime = datetime.strptime(after_datetime_str, "%Y-%m-%d %H:%M:%S")
        print("garmin last activity date: ", after_datetime)
        for file_path, file_id_mesgs_time_created_str in all_fit_files.values():
            file_id_mesgs_time_created = datetime.strptime(
                file_id_mesgs_time_created_str, "%Y-%m-%d %H:%M:%S"
            )
            if after_datetime == file_id_mesgs_time_created:
                break
            else:
                upload_file_path.append(file_path)
        await garmin_client.upload_activities_fit(upload_file_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "secret_string", nargs="?", help="secret_string fro get_garmin_secret.py"
    )
    parser.add_argument(
        "--is-cn",
        dest="is_cn",
        action="store_true",
        help="if garmin accout is cn",
    )
    options = parser.parse_args()
    secret_string = options.secret_string or config("sync", "garmin", "secret_string")
    garmin_auth_domain = "CN" if options.is_cn else ""
    if secret_string is None:
        print("Missing argument nor valid configuration file")
        sys.exit(1)
    loop = asyncio.get_event_loop()
    future = asyncio.ensure_future(main(secret_string, garmin_auth_domain))
    loop.run_until_complete(future)
