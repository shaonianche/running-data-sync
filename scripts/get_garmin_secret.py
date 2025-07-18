import argparse

import garth

from utils import load_env_config


def get_garmin_secret(email=None, password=None, is_cn=False):
    # if no credentials, try to load from env
    if not all([email, password]):
        env_config = load_env_config()
        if env_config and all(k in env_config for k in ["garmin_email", "garmin_password"]):
            email = email or env_config["garmin_email"]
            password = password or env_config["garmin_password"]
            # if is_cn is not specified, use the setting from env
            if not is_cn and env_config.get("garmin_is_cn"):
                is_cn = env_config["garmin_is_cn"].lower() == "true"
        else:
            raise ValueError("Missing Garmin credentials. Please provide them as arguments or in .env.local file")

    if is_cn:
        garth.configure(domain="garmin.cn")
    garth.login(email, password)
    return garth.client.dumps()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("email", nargs="?", help="email of garmin")
    parser.add_argument("password", nargs="?", help="password of garmin")
    parser.add_argument(
        "--is-cn",
        dest="is_cn",
        action="store_true",
        help="if garmin account is cn",
    )
    options = parser.parse_args()

    try:
        secret_string = get_garmin_secret(
            options.email,
            options.password,
            is_cn=options.is_cn,
        )
        print(secret_string)
    except ValueError as e:
        print(str(e))
        exit(1)
