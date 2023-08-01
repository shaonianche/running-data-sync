import argparse
import asyncio
import os
from collections import namedtuple
from datetime import datetime, timedelta
from pprint import pprint

from config import FIT_FOLDER
from garmin_fit_sdk import Decoder, Stream
from garmin_sync import Garmin


async def upload_fit(garmin_client):
    last_activity = await garmin_client.get_activities(0, 1)
    if not last_activity:
        print("no garmin activity")
        filters = {}
    else:
        # is this startTimeGMT must have ?
        after_datetime_str = last_activity[0]["startTimeGMT"]
        after_datetime = datetime.strptime(after_datetime_str, "%Y-%m-%d %H:%M:%S")
        print("garmin last activity date: ", after_datetime)
        filters = {"after": after_datetime}

    files_list = ["/root/workspace/running-data-sync/FIT_OUT/2023-07-25-183153.fit"]

    # await garmin_client.upload_activities_fit(files_list)


def fit():
    stream = Stream.from_file(
        "/root/workspace/running-data-sync/FIT_OUT/2023-07-25-183153.fit"
    )
    decoder = Decoder(stream)
    messages, errors = decoder.read()
    print(errors)

    for key in messages
        print(key)


# if after_datetime == formatted_date_time:
#     print("The times are equal.")
# else:
#     print("The times are not equal.")


if __name__ == "__main__":
    email = ("home@duanfei.org",)
    password = ("FSkM4Ss4oqX*RFew*tNBo3&o^",)
    auth_domain = ("CN",)
    garmin_client = Garmin(email, password, auth_domain)
    # asyncio.run(upload_fit(garmin_client))
    fit()
