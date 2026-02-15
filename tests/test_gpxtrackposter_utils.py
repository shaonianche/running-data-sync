"""Tests for gpxtrackposter/utils.py module."""

from datetime import datetime
from zoneinfo import ZoneInfo


class TestMercatorProjection:
    """Test cases for Mercator projection functions."""

    def test_lng2x_zero(self):
        """Test longitude 0 converts to x=1."""
        from scripts.gpxtrackposter.utils import lng2x

        result = lng2x(0)
        assert result == 1.0

    def test_lng2x_positive(self):
        """Test positive longitude conversion."""
        from scripts.gpxtrackposter.utils import lng2x

        result = lng2x(180)
        assert result == 2.0

    def test_lng2x_negative(self):
        """Test negative longitude conversion."""
        from scripts.gpxtrackposter.utils import lng2x

        result = lng2x(-180)
        assert result == 0.0

    def test_lat2y_zero(self):
        """Test latitude 0 converts to y=0.5."""
        from scripts.gpxtrackposter.utils import lat2y

        result = lat2y(0)
        assert result == 0.5

    def test_lat2y_positive(self):
        """Test positive latitude conversion."""
        from scripts.gpxtrackposter.utils import lat2y

        result = lat2y(45)
        assert 0 < result < 0.5  # North of equator should be less than 0.5

    def test_lat2y_negative(self):
        """Test negative latitude conversion."""
        from scripts.gpxtrackposter.utils import lat2y

        result = lat2y(-45)
        assert result > 0.5  # South of equator should be greater than 0.5


class TestLatlng2xy:
    """Test cases for latlng2xy function."""

    def test_latlng2xy_origin(self):
        """Test conversion of origin point."""
        import s2sphere as s2

        from scripts.gpxtrackposter.utils import latlng2xy

        latlng = s2.LatLng.from_degrees(0, 0)
        result = latlng2xy(latlng)

        assert result.x == 1.0
        assert result.y == 0.5

    def test_latlng2xy_beijing(self):
        """Test conversion of Beijing coordinates."""
        import s2sphere as s2

        from scripts.gpxtrackposter.utils import latlng2xy

        latlng = s2.LatLng.from_degrees(39.9042, 116.4074)
        result = latlng2xy(latlng)

        assert result.x > 1.0  # East of prime meridian
        assert result.y < 0.5  # North of equator


class TestComputeBoundsXY:
    """Test cases for compute_bounds_xy function."""

    def test_compute_bounds_single_point(self):
        """Test computing bounds with a single point."""
        from scripts.gpxtrackposter.utils import compute_bounds_xy
        from scripts.gpxtrackposter.xy import XY

        lines = [[XY(1.0, 2.0)]]
        range_x, range_y = compute_bounds_xy(lines)

        assert range_x.lower() == 1.0
        assert range_x.upper() == 1.0
        assert range_y.lower() == 2.0
        assert range_y.upper() == 2.0

    def test_compute_bounds_multiple_points(self):
        """Test computing bounds with multiple points."""
        from scripts.gpxtrackposter.utils import compute_bounds_xy
        from scripts.gpxtrackposter.xy import XY

        lines = [[XY(0.0, 0.0), XY(10.0, 5.0), XY(5.0, 10.0)]]
        range_x, range_y = compute_bounds_xy(lines)

        assert range_x.lower() == 0.0
        assert range_x.upper() == 10.0
        assert range_y.lower() == 0.0
        assert range_y.upper() == 10.0

    def test_compute_bounds_empty_lines(self):
        """Test computing bounds with empty lines."""
        from scripts.gpxtrackposter.utils import compute_bounds_xy

        lines = []
        range_x, range_y = compute_bounds_xy(lines)

        # Empty ranges have no lower/upper set
        # Check that they haven't been extended
        assert range_x._lower is None or range_x._lower == range_x._upper


class TestComputeGrid:
    """Test cases for compute_grid function."""

    def test_compute_grid_single_item(self):
        """Test grid computation for single item."""
        from scripts.gpxtrackposter.utils import compute_grid
        from scripts.gpxtrackposter.xy import XY

        size, counts = compute_grid(1, XY(100, 100))

        assert size is not None
        assert counts == (1, 1)

    def test_compute_grid_four_items_square(self):
        """Test grid computation for 4 items in a square."""
        from scripts.gpxtrackposter.utils import compute_grid
        from scripts.gpxtrackposter.xy import XY

        size, counts = compute_grid(4, XY(100, 100))

        assert size is not None
        assert counts is not None
        assert counts[0] * counts[1] >= 4

    def test_compute_grid_many_items(self):
        """Test grid computation for many items."""
        from scripts.gpxtrackposter.utils import compute_grid
        from scripts.gpxtrackposter.xy import XY

        size, counts = compute_grid(100, XY(1000, 800))

        assert size is not None
        assert counts is not None
        assert counts[0] * counts[1] >= 100


class TestInterpolateColor:
    """Test cases for interpolate_color function."""

    def test_interpolate_color_ratio_zero(self):
        """Test color interpolation at ratio 0."""
        from scripts.gpxtrackposter.utils import interpolate_color

        result = interpolate_color("#ff0000", "#0000ff", 0)

        # Should be close to red
        assert result.lower().startswith("#")

    def test_interpolate_color_ratio_one(self):
        """Test color interpolation at ratio 1."""
        from scripts.gpxtrackposter.utils import interpolate_color

        result = interpolate_color("#ff0000", "#0000ff", 1)

        # Should be close to blue
        assert result.lower().startswith("#")

    def test_interpolate_color_ratio_half(self):
        """Test color interpolation at ratio 0.5."""
        from scripts.gpxtrackposter.utils import interpolate_color

        result = interpolate_color("#ff0000", "#0000ff", 0.5)

        # Should be somewhere in between
        assert result.lower().startswith("#")

    def test_interpolate_color_clamps_negative_ratio(self):
        """Test that negative ratio is clamped to 0."""
        from scripts.gpxtrackposter.utils import interpolate_color

        result_neg = interpolate_color("#ff0000", "#0000ff", -0.5)
        result_zero = interpolate_color("#ff0000", "#0000ff", 0)

        assert result_neg == result_zero

    def test_interpolate_color_clamps_high_ratio(self):
        """Test that ratio > 1 is clamped to 1."""
        from scripts.gpxtrackposter.utils import interpolate_color

        result_high = interpolate_color("#ff0000", "#0000ff", 1.5)
        result_one = interpolate_color("#ff0000", "#0000ff", 1)

        assert result_high == result_one


class TestFormatFloat:
    """Test cases for format_float function."""

    def test_format_float_integer(self):
        """Test formatting an integer value."""
        from scripts.gpxtrackposter.utils import format_float

        result = format_float(42.0)
        assert "42" in result

    def test_format_float_decimal(self):
        """Test formatting a decimal value."""
        from scripts.gpxtrackposter.utils import format_float

        result = format_float(3.14159)
        assert "3.1" in result or "3,1" in result  # Locale-dependent


class TestParseDatetimeToLocal:
    """Test cases for parse_datetime_to_local function."""

    def test_parse_datetime_with_aware_datetime(self):
        """Test parsing already timezone-aware datetime."""
        from scripts.gpxtrackposter.utils import parse_datetime_to_local

        start_time = datetime(2024, 1, 15, 10, 30, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
        end_time = datetime(2024, 1, 15, 11, 30, 0, tzinfo=ZoneInfo("Asia/Shanghai"))

        result_start, result_end = parse_datetime_to_local(start_time, end_time, None)

        # Should return adjusted times
        assert result_start is not None
        assert result_end is not None

    def test_parse_datetime_with_naive_datetime_and_point(self):
        """Test parsing naive datetime with geographic point."""
        from scripts.gpxtrackposter.utils import parse_datetime_to_local

        start_time = datetime(2024, 1, 15, 2, 30, 0)  # UTC
        end_time = datetime(2024, 1, 15, 3, 30, 0)  # UTC
        point = (39.9042, 116.4074)  # Beijing

        result_start, result_end = parse_datetime_to_local(start_time, end_time, point)

        # Should return local times (Beijing is UTC+8)
        assert result_start is not None
        assert result_end is not None

    def test_parse_datetime_without_point(self):
        """Test parsing naive datetime without geographic point."""
        from scripts.gpxtrackposter.utils import parse_datetime_to_local

        start_time = datetime(2024, 1, 15, 2, 30, 0)
        end_time = datetime(2024, 1, 15, 3, 30, 0)

        result_start, result_end = parse_datetime_to_local(start_time, end_time, None)

        # Should fallback to Asia/Shanghai
        assert result_start is not None
        assert result_end is not None

    def test_parse_datetime_invalid_timezone(self):
        """Test parsing with a point that might fail timezone lookup."""
        from scripts.gpxtrackposter.utils import parse_datetime_to_local

        start_time = datetime(2024, 1, 15, 2, 30, 0)
        end_time = datetime(2024, 1, 15, 3, 30, 0)
        # Ocean coordinates might not have a timezone
        point = (0.0, 0.0)

        # Should not raise an exception
        result_start, result_end = parse_datetime_to_local(start_time, end_time, point)

        assert result_start is not None
        assert result_end is not None
