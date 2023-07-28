import argparse
import asyncio
from datetime import datetime, timedelta

from garmin_sync import Garmin
from garmin_fit_sdk import Decoder, Stream, Profile
import json

async def upload_to_activities(
    garmin_client, use_fake_garmin_device
):
    print("garmin login")
    last_activity = await garmin_client.get_activities(0, 1)
    if not last_activity:
        print("no garmin activity")
        filters = {}
    else:
        after_datetime_str = last_activity[0]["startTimeGMT"]
        after_datetime = datetime.strptime(after_datetime_str, "%Y-%m-%d %H:%M:%S")
        print("garmin last activity date: ", after_datetime)

if __name__ == "__main__":
    garmin_email = "home@duanfei.org"
    garmin_password = "FSkM3Ss4oqX*RFew*tNBo3&o^"
    garmin_auth_domain = "CN"
    garmin_client = Garmin(garmin_email, garmin_password, garmin_auth_domain)

    use_fake_garmin_device = True

    stream = Stream.from_file("../FIT_OUT/2023-07-27-182544.fit")
    decoder = Decoder(stream)
    messages, errors = decoder.read()
    record_fields = set()
    def mesg_listener(mesg_num, message):
        if mesg_num == Profile['mesg_num']['RECORD']:
            for field in message:
                record_fields.add(field)

    messages, errors = decoder.read(mesg_listener=mesg_listener)

    if len(errors) > 0:
        print(f"Something went wrong decoding the file: {errors}")

    print(record_fields)
