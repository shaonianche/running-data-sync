"""Assorted utility methods for use in creating posters."""

# Copyright 2016-2019 Florian Pigorsch & Contributors. All rights reserved.
#
# Use of this source code is governed by a MIT-style
# license that can be found in the LICENSE file.

import locale
import math
from typing import List, Optional, Tuple
from zoneinfo import ZoneInfo

import colour
import s2sphere as s2
from timezonefinder import TimezoneFinder

from .value_range import ValueRange
from .xy import XY

try:
    from tzfpy import get_tz
except ImportError:
    get_tz = None

_TIMEZONE_FINDER_INSTANCE: Optional[TimezoneFinder] = None


def _get_timezone_finder() -> TimezoneFinder:
    """Lazy-load the TimezoneFinder instance to improve startup performance."""
    global _TIMEZONE_FINDER_INSTANCE
    if _TIMEZONE_FINDER_INSTANCE is None:
        # This initialization is deferred until it's actually needed.
        _TIMEZONE_FINDER_INSTANCE = TimezoneFinder()
    return _TIMEZONE_FINDER_INSTANCE


# mercator projection
def latlng2xy(latlng: s2.LatLng) -> XY:
    return XY(lng2x(latlng.lng().degrees), lat2y(latlng.lat().degrees))


def lng2x(lng_deg: float) -> float:
    return lng_deg / 180 + 1


def lat2y(lat_deg: float) -> float:
    return 0.5 - math.log(math.tan(math.pi / 4 * (1 + lat_deg / 90))) / math.pi


def project(
    bbox: s2.LatLngRect, size: XY, offset: XY, latlnglines: List[List[s2.LatLng]]
) -> List[List[Tuple[float, float]]]:
    min_x = lng2x(bbox.lng_lo().degrees)
    d_x = lng2x(bbox.lng_hi().degrees) - min_x
    while d_x >= 2:
        d_x -= 2
    while d_x < 0:
        d_x += 2
    min_y = lat2y(bbox.lat_lo().degrees)
    max_y = lat2y(bbox.lat_hi().degrees)
    d_y = abs(max_y - min_y)
    # the distance maybe zero
    if d_x == 0 or d_y == 0:
        return []
    scale = size.x / d_x if size.x / size.y <= d_x / d_y else size.y / d_y
    offset = offset + 0.5 * (size - scale * XY(d_x, -d_y)) - scale * XY(min_x, min_y)
    lines = []
    # If len > $zoom_threshold, choose 1 point out of every $step to reduce size of the SVG file
    zoom_threshold = 400
    for latlngline in latlnglines:
        line = []
        step = int(len(latlngline) / zoom_threshold) + 1
        for i in range(0, len(latlngline), step):
            latlng = latlngline[i]
            if bbox.contains(latlng):
                line.append((offset + scale * latlng2xy(latlng)).tuple())
            else:
                if len(line) > 0:
                    lines.append(line)
                    line = []
        if len(line) > 0:
            lines.append(line)
    return lines


def compute_bounds_xy(lines: List[List[XY]]) -> Tuple[ValueRange, ValueRange]:
    range_x = ValueRange()
    range_y = ValueRange()
    for line in lines:
        for xy in line:
            range_x.extend(xy.x)
            range_y.extend(xy.y)
    return range_x, range_y


def compute_grid(count: int, dimensions: XY) -> Tuple[Optional[float], Optional[Tuple[int, int]]]:
    # this is somehow suboptimal O(count^2). I guess it's possible in O(count)
    min_waste = -1.0
    best_size = None
    best_counts = None
    for count_x in range(1, count + 1):
        size_x = dimensions.x / count_x
        for count_y in range(1, count + 1):
            if count_x * count_y >= count:
                size_y = dimensions.y / count_y
                size = min(size_x, size_y)
                waste = dimensions.x * dimensions.y - count * size * size
                if waste < 0:
                    continue
                elif best_size is None or waste < min_waste:
                    best_size = size
                    best_counts = count_x, count_y
                    min_waste = waste
    return best_size, best_counts


def interpolate_color(color1: str, color2: str, ratio: float) -> str:
    if ratio < 0:
        ratio = 0
    elif ratio > 1:
        ratio = 1
    c1 = colour.Color(color1)
    c2 = colour.Color(color2)
    c3 = colour.Color(
        hue=((1 - ratio) * c1.hue + ratio * c2.hue),
        saturation=((1 - ratio) * c1.saturation + ratio * c2.saturation),
        luminance=((1 - ratio) * c1.luminance + ratio * c2.luminance),
    )
    return c3.hex_l


def format_float(f):
    return locale.format_string("%.1f", f)


def parse_datetime_to_local(start_time, end_time, point):
    """
    Converts naive UTC datetime objects to local time based on a geographical point.

    It first checks if the datetime is already timezone-aware. If not, it uses
    the provided point (lat, lng) to find the correct timezone name and then
    calculates the local time.
    """
    # If the datetime object is already "aware", we can use its offset directly.
    offset = start_time.utcoffset()
    if offset:
        # Note: This assumes start and end times are in the same timezone,
        # which is safe for single activities.
        return start_time + offset, end_time + offset

    timezone_name = None
    if point:
        lat, lng = point
        # Prefer the faster `tzfpy` library if available.
        if get_tz:
            timezone_name = get_tz(lng=lng, lat=lat)
        # Fallback to `timezonefinder` if the first attempt fails.
        if not timezone_name:
            tf = _get_timezone_finder()
            timezone_name = tf.timezone_at(lng=lng, lat=lat)

    # Use a default fallback if no timezone could be determined.
    timezone_name = timezone_name or "Asia/Shanghai"

    try:
        tz = ZoneInfo(timezone_name)
        # Calculate offset based on the actual start_time (assuming it's naive UTC)
        start_tc_offset = start_time.replace(tzinfo=ZoneInfo("UTC")).astimezone(tz).utcoffset()
        end_tc_offset = end_time.replace(tzinfo=ZoneInfo("UTC")).astimezone(tz).utcoffset()
        return start_time + start_tc_offset, end_time + end_tc_offset
    except Exception:
        # If any part of the conversion fails, return the original times to prevent a crash.
        return start_time, end_time
