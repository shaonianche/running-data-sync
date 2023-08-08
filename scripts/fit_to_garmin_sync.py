import argparse
import asyncio
import os
from datetime import datetime

from config import FIT_FOLDER, config
from garmin_fit_sdk import Decoder, Stream
from garmin_sync import Garmin


class FitToGarmin(Garmin):
    def __init__(self, email, password, auth_domain):
        super().__init__(email, password, auth_domain)

    async def upload_activities_fit(self, files):
        print("start upload fit file to garmin ...")
        if not self.is_login:
            self.login()
            print("login success ...")

        for fit_file_path in files:
            with open(fit_file_path, "rb") as f:
                file_body = f.read()
            files = {"data": (fit_file_path, file_body)}

            try:
                res = await self.req.post(
                    self.upload_url, files=files, headers={"nk": "NT"}
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


async def main(email, password, auth_domain):
    garmin_client = FitToGarmin(email, password, auth_domain)
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
    parser.add_argument("email", nargs="?", help="email of garmin")
    parser.add_argument("password", nargs="?", help="password of garmin")
    parser.add_argument(
        "--is-cn",
        dest="is_cn",
        action="store_true",
        help="if garmin accout is cn",
    )
    options = parser.parse_args()
    email = options.email or config("sync", "garmin", "email")
    password = options.password or config("sync", "garmin", "password")
    auth_domain = (
        "CN" if options.is_cn else config("sync", "garmin", "authentication_domain")
    )
    if email == None or password == None:
        print("Missing argument nor valid configuration file")
        sys.exit(1)
    loop = asyncio.get_event_loop()
    future = asyncio.ensure_future(main(email, password, auth_domain))
    loop.run_until_complete(future)