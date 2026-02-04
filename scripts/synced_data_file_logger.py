import json
import os

from .config import SYNCED_FILE

from .utils import get_logger

logger = get_logger(__name__)


def save_synced_data_file_list(file_list: list):
    old_list = load_synced_file_list()

    with open(SYNCED_FILE, "w") as f:
        file_list.extend(old_list)

        json.dump(file_list, f)


def load_synced_file_list():
    if os.path.exists(SYNCED_FILE):
        with open(SYNCED_FILE, "r") as f:
            try:
                return json.load(f)
            except Exception as e:
                logger.error(f"json load {SYNCED_FILE} error: {e}")
                pass

    return []
